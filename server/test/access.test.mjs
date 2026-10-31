// Every API route checks who is asking, on the server. The routes are read from the routers themselves, so a route
// added later is checked too, and a route that should be open must be listed in PUBLIC on purpose.
// - signed out: everything not in PUBLIC answers 401/403
// - /pr/* and /reports*: not for staff or students (403); /admin/*: not for PR (403)
// Also: no secrets in the code (keys, passwords) and .env stays out of the repository.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { BASE, login, request } from './helpers.mjs';

const MODULES = ['auth', 'news', 'submissions', 'pr', 'newsdesk', 'reports', 'admin', 'notify', 'privacy', 'calendar'];
// Open without signing in (what a reader of the public site uses)
const PUBLIC = new Set(['POST /auth/google', 'POST /auth/dev', 'POST /auth/logout', 'GET /me', 'GET /news', 'GET /news/search', 'GET /news/archive',
  'GET /news/:id', 'POST /news/:id/read', 'GET /calendar/public']);
const ORIGIN = process.env.APP_ORIGIN || BASE;
const UUID = '00000000-0000-4000-8000-000000000000';
const fill = (path) => path.replace(/:(\w+)/g, (m, k) => (k === 'ref' ? 'NW-2569-0001' : k === 'email' ? 'x%40sru.ac.th' : k === 'file' ? `${UUID}.webp` : k === 'key' ? 'categories' : UUID));

async function routes() {
  const out = [];
  for (const m of MODULES) {
    const { router } = await import(`../${m}.mjs`);
    for (const layer of router.stack) if (layer.route) for (const method of Object.keys(layer.route.methods)) out.push({ method: method.toUpperCase(), path: layer.route.path });
  }
  return out;
}
const call = (who, method, path) => (who ? who.call : (...a) => request(...a))(method, `/api${fill(path)}`, ['GET', 'HEAD'].includes(method) ? undefined : {}, { Origin: ORIGIN });

describe('access is checked on the server for every route', () => {
  test('signed out: every route that is not public answers 401 or 403', async () => {
    const all = await routes();
    assert.ok(all.length > 60, `found ${all.length} routes`);
    const open = [];
    for (const r of all) {
      if (PUBLIC.has(`${r.method} ${r.path}`)) continue;
      const res = await call(null, r.method, r.path);
      if (![401, 403].includes(res.status)) open.push(`${r.method} ${r.path} → ${res.status}`);
    }
    assert.deepEqual(open, [], 'routes reachable without signing in');
  });

  test('staff and students cannot use the PR desk, reports or admin; PR cannot use admin', async () => {
    const all = await routes();
    const [staff, pr] = await Promise.all([login('staff'), login('pr')]);
    const wrong = [];
    for (const r of all) {
      const prOnly = /^\/(pr|reports)/.test(r.path), adminOnly = /^\/admin/.test(r.path);
      if (prOnly || adminOnly) {
        const res = await call(staff, r.method, r.path);
        if (res.status !== 403) wrong.push(`staff ${r.method} ${r.path} → ${res.status}`);
      }
      if (adminOnly) {
        const res = await call(pr, r.method, r.path);
        if (res.status !== 403) wrong.push(`pr ${r.method} ${r.path} → ${res.status}`);
      }
    }
    assert.deepEqual(wrong, []);
  });
});

describe('no secrets in the code', () => {
  const ROOT = resolve(import.meta.dirname, '..', '..');
  const SKIP = new Set(['node_modules', 'uploads', 'backups', '.git', 'assets']);
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name) || (name.startsWith('.env') && name !== '.env.example')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(m?js|cjs|html|json|ya?ml|sql|md|example|txt)$/.test(name) || name === '.gitignore') files.push(p);
    }
  })(ROOT);

  test('no private keys, API keys or passwords written in the files', () => {
    /** @type {[RegExp, string][]} */
    const PATTERNS = [
      [/-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/, 'private key'],
      [/AKIA[0-9A-Z]{16}/, 'AWS key'],
      [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
      [/GOCSPX-[0-9A-Za-z_-]{20,}/, 'Google OAuth client secret'],
      [/xox[abp]-[0-9A-Za-z-]{10,}/, 'Slack token'],
      [/\b(SMTP_PASS|PGPASSWORD|READ_SALT)[ \t]*=[ \t]*(?!prsru-dev\b)[^\s#'"`$]{6,}/, 'a password in a file'],
    ];
    const found = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const [re, what] of PATTERNS) if (re.test(text)) found.push(`${f.replace(ROOT, '')}: ${what}`);
    }
    assert.deepEqual(found, []);
  });

  test('.env and uploads are ignored by Git; .env.example has no real values', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
    for (const line of ['.env', 'uploads/', 'backups/', 'node_modules/']) assert.ok(ignore.includes(line), `.gitignore has ${line}`);
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    for (const k of ['GOOGLE_CLIENT_ID', 'SMTP_PASS', 'READ_SALT']) assert.match(example, new RegExp(`^${k}=$`, 'm'), `${k} is empty in .env.example`);
  });
});

describe('HTTPS and production settings', () => {
  test('production sends plain HTTP to the HTTPS address (from APP_ORIGIN, not the Host header) and refuses changes', async () => {
    const { httpsOnly } = await import('../security.mjs');
    const mw = httpsOnly('https://news.sru.ac.th');
    const run = (req) => new Promise((done) => {
      const res = { redirect: (code, url) => done({ code, url }), status(c) { this.c = c; return this; }, type() { return this; }, send() { done({ code: this.c }); } };
      mw({ headers: { host: 'evil.example' }, ...req }, res, () => done({ next: true }));
    });
    assert.deepEqual(await run({ secure: false, method: 'GET', originalUrl: '/news.html?id=1' }), { code: 301, url: 'https://news.sru.ac.th/news.html?id=1' });
    assert.deepEqual(await run({ secure: false, method: 'POST', originalUrl: '/api/submissions' }), { code: 403 });
    assert.deepEqual(await run({ secure: true, method: 'GET', originalUrl: '/' }), { next: true });
  });
  test('the app will not start in production with development or sample settings', async () => {
    const { productionProblems } = await import('../security.mjs');
    assert.equal(productionProblems({ APP_ORIGIN: 'http://localhost:3000', ALLOW_DEV_LOGIN: '1', PGPASSWORD: 'prsru-dev' }).length, 5);
    assert.deepEqual(productionProblems({ APP_ORIGIN: 'https://news.sru.ac.th', GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com', ALLOW_DEV_LOGIN: '0', PGPASSWORD: 'a-long-random-password', READ_SALT: 'f'.repeat(32) }), []);
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, ['server/index.mjs'], { cwd: resolve(import.meta.dirname, '..', '..'), env: { ...process.env, NODE_ENV: 'production', ALLOW_DEV_LOGIN: '1' }, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ALLOW_DEV_LOGIN must be 0/);
  });
});
