// Security helpers (phase 10)
// - headers(): CSP, HSTS (HTTPS only) and the other response headers for every request
// - limit(name, { max, windowMs, by }): rate limit per IP or per signed-in user (in memory, one app process)
// - sniff(path): what a file really is, from its first bytes; matchesName(kind, name) checks it against the extension
// - httpsOnly(origin): in production, plain-HTTP requests are sent to the HTTPS address (pages) or refused (API)
// - productionProblems(env): settings that must not reach the server (index.mjs refuses to start with any)
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { HttpError } from './http.mjs';

// ---- Response headers ----
// Pages are static HTML with inline scripts, so scripts need 'unsafe-inline'. CSS, fonts and pdf.js are served from this site
// (assets/); the only other origin a reader's browser talks to is Google, and only on login.html (Google sign-in).
// The policy still blocks scripts, frames, forms and plugins from anywhere not listed here.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "font-src 'self'",
  // Story images, YouTube thumbnails, Facebook photos in the import preview, PDF pages drawn to data: URLs
  "img-src 'self' data: blob: https://img.youtube.com https://*.fbcdn.net https://lh3.googleusercontent.com",
  "connect-src 'self' https://accounts.google.com/gsi/",
  "frame-src https://accounts.google.com/gsi/",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

export function headers(req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    // Google Sign-In opens a popup that must be able to answer this page
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  });
  // HSTS only means something over HTTPS (behind the university's proxy: X-Forwarded-Proto)
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// HTTPS on every page. The address comes from APP_ORIGIN, never from the request's Host header.
// req.secure is true behind the reverse proxy when it sends X-Forwarded-Proto: https (trust proxy in index.mjs).
export function httpsOnly(origin) {
  const base = origin.replace(/\/$/, '');
  return (req, res, next) => {
    if (req.secure) return next();
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(301, base + req.originalUrl);
    res.status(403).type('text/plain; charset=utf-8').send('ใช้ HTTPS เท่านั้น');
  };
}

// What NODE_ENV=production must not start with. Sample values are the ones in .env.example / docker-compose.yml.
export function productionProblems(env) {
  const p = [];
  if (!/^https:\/\//.test(env.APP_ORIGIN || '')) p.push('APP_ORIGIN must be the https:// address of the site');
  if (!env.GOOGLE_CLIENT_ID) p.push('GOOGLE_CLIENT_ID is empty (sign-in is Google only)');
  if (env.ALLOW_DEV_LOGIN === '1') p.push('ALLOW_DEV_LOGIN must be 0 (development sign-in)');
  if (!env.PGPASSWORD || env.PGPASSWORD === 'prsru-dev') p.push('PGPASSWORD is empty or the sample password');
  if (!env.READ_SALT || env.READ_SALT.length < 16) p.push('READ_SALT must be a long random text');
  return p;
}

// ---- Rate limits ----
// Development sign-in accounts (auth.mjs, ALLOW_DEV_LOGIN=1, never in production): the test suite sends a lot of work
// through them, so per-account limits skip them. Limits per IP (sign-in) still apply.
export const DEV_ACCOUNTS = {
  staff: 'user@sru.ac.th', student: 'user@student.sru.ac.th', external: 'user@gmail.com',
  pr: 'pr@sru.ac.th', admin: 'admin@sru.ac.th', coordinator: 'coord@sru.ac.th',
  developer: 'satearnpong.nis@sru.ac.th', // DEVELOPERS in auth.mjs: switches between PR and ผู้พัฒนาระบบ
};
const DEV_ON = process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_LOGIN === '1';
const DEV_SET = new Set(Object.values(DEV_ACCOUNTS));
// Fixed windows kept in memory; old windows are dropped as they expire.
const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}, 60 * 1000).unref();

// by: 'ip' (sign-in) or 'user' (signed-in actions; falls back to the IP)
export function limit(name, { max, windowMs, by = 'user', message }) {
  return (req, res, next) => {
    if (DEV_ON && by === 'user' && req.user && !req.user.google_sub && DEV_SET.has(req.user.email)) return next();
    const who = by === 'user' && req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
    const key = `${name}|${who}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset <= now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.n += 1;
    if (b.n > max) {
      const wait = Math.ceil((b.reset - now) / 1000);
      res.set('Retry-After', String(wait));
      const mins = Math.ceil(wait / 60);
      throw new HttpError(429, message || `ทำรายการนี้บ่อยเกินไป กรุณารอ ${wait < 90 ? `${wait} วินาที` : `${mins} นาที`} แล้วลองใหม่`);
    }
    next();
  };
}

// ---- File types from their content ----
const head = async (path, n = 32) => {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
};
// jpeg, png, webp, heic, pdf, ole (doc/xls/ppt), zip (docx/xlsx/pptx) or null
export async function sniff(path) {
  const b = await head(path);
  const s = (from, to) => b.subarray(from, to).toString('latin1');
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (s(0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'webp';
  if (s(4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)$/.test(s(8, 12))) return 'heic';
  if (s(0, 5) === '%PDF-') return 'pdf';
  if (b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole';
  if (s(0, 4) === 'PK\x03\x04') return 'zip';
  return null;
}
const BY_EXT = {
  '.jpg': ['jpeg'], '.jpeg': ['jpeg'], '.png': ['png'], '.webp': ['webp'], '.heic': ['heic'], '.pdf': ['pdf'],
  '.doc': ['ole'], '.xls': ['ole'], '.ppt': ['ole'], '.docx': ['zip'], '.xlsx': ['zip'], '.pptx': ['zip'],
};
// True when the content is what the file name says
export async function matchesName(path, name) {
  const want = BY_EXT[extname(name).toLowerCase()];
  if (!want) return false;
  return want.includes(await sniff(path));
}
