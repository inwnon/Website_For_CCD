// Web Push: in-app notices (the notifications table) on the phone's lock screen, free of charge.
// Browsers' push services (Google FCM, Mozilla, Apple, Microsoft) need no account or API key: we sign with our own
// VAPID key (RFC 8292) and encrypt each message for the browser (RFC 8291), with node:crypto only.
// - VAPID keys are made on first use and kept in settings ('push.vapid', not one of the editable settings), so they move
//   with the database backup and phones stay subscribed after a move to another server
// - pushPending(): every 10 s (index.mjs) sends notices not pushed yet to every browser of their user; a notice older
//   than an hour is only marked; a browser the push service no longer knows (404/410) is removed
// - GET /api/push/key · POST /api/push/subscribe · /check · /unsubscribe · /test (push.js)
// - logging out removes the browsers turned on in that sign-in (auth.mjs), so a shared computer stops getting notices
import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { Router } from 'express';
import { requireBackOffice } from './access.mjs';
import { audit } from './audit.mjs';
import { one, query, tx } from './db.mjs';
import { HttpError } from './http.mjs';
import { limit } from './security.mjs';

const ORIGIN = (process.env.APP_ORIGIN || 'http://localhost:3000').replace(/\/$/, '');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

// ---- Push services we send to (nothing else: the endpoint comes from the browser) ----
const HOSTS = [/^fcm\.googleapis\.com$/, /^([\w-]+\.)*push\.services\.mozilla\.com$/, /^([\w-]+\.)*push\.apple\.com$/, /^([\w-]+\.)*notify\.windows\.com$/];
export function allowedEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  return u.protocol === 'https:' && !u.port && !u.username && !u.password && HOSTS.some((h) => h.test(u.hostname));
}

// ---- Encryption (RFC 8291, aes128gcm): one record. salt and asPrivate are only passed by the test vectors ----
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
/**
 * @param {{ p256dh: string, auth: string }} keys
 * @param {Buffer|string} payload
 * @param {{ salt?: Buffer, asPrivate?: Buffer }} [fixed]
 */
export function encrypt(keys, payload, { salt = randomBytes(16), asPrivate } = {}) {
  const uaPublic = unb64u(keys.p256dh);
  const ecdh = createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(unb64u(keys.auth), secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// ---- VAPID (RFC 8292) ----
let keysPromise = null;
/** @returns {Promise<{ publicKey: string, privateJwk: import('node:crypto').webcrypto.JsonWebKey }>} */
export function vapidKeys() {
  keysPromise ||= (async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    const fresh = { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])), privateJwk: jwk };
    // Two app processes starting together keep whichever was saved first
    await query(`insert into settings (key, value) values ('push.vapid', $1) on conflict (key) do nothing`, [JSON.stringify(fresh)]);
    return (await one(`select value from settings where key = 'push.vapid'`)).value;
  })().catch((err) => { keysPromise = null; throw err; });
  return keysPromise;
}
export async function vapidHeader(endpoint) {
  const { publicKey, privateJwk } = await vapidKeys();
  const subject = ORIGIN.startsWith('https://') ? ORIGIN : 'mailto:no-reply@sru.ac.th';
  const part = (o) => b64u(JSON.stringify(o));
  const data = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const sig = sign('sha256', Buffer.from(data), { key: createPrivateKey({ key: privateJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${publicKey}`;
}

// ---- Sending ----
// Returns the push service's status (201 = accepted); 404/410 removes the browser
async function send(sub, message) {
  if (!allowedEndpoint(sub.endpoint)) { await query('delete from push_subscriptions where id = $1', [sub.id]); return 0; }
  let status;
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: await vapidHeader(sub.endpoint), TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' },
      body: encrypt(sub, JSON.stringify(message)),
    });
    status = res.status;
  } catch (err) {
    console.error('push:', err.message);
    return 0;
  }
  if (status === 404 || status === 410) await query('delete from push_subscriptions where id = $1', [sub.id]);
  else if (status >= 200 && status < 300) await query('update push_subscriptions set last_ok_at = now() where id = $1', [sub.id]);
  else console.error('push: service answered', status);
  return status;
}
async function sendToUser(userId, message) {
  const subs = (await query('select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1', [userId])).rows;
  const results = await Promise.all(subs.map((s) => send(s, message)));
  return { devices: subs.length, sent: results.filter((s) => s >= 200 && s < 300).length };
}

// Where tapping the notification goes
export function urlOf(kind, refId) {
  const id = encodeURIComponent(refId ?? '');
  if (kind.startsWith('event.')) return `/calendar.html?id=${id}`;
  if (kind.startsWith('request.')) return `/requests.html?id=${id}`;
  if (kind.startsWith('access.')) return '/requests.html';
  if (kind.startsWith('feedback.')) return '/pr.html?feedback';
  return '/calendar.html';
}

let pushing = false;
export async function pushPending() {
  if (pushing) return;
  pushing = true;
  try {
    // Claimed and marked first: each notice is pushed at most once, even with two app processes
    const rows = await tx(async (c) => (await c.query(`update notifications set pushed_at = now() where id in (
        select id from notifications where pushed_at is null order by id limit 50 for update skip locked)
      returning id, user_id, kind, ref_id, text, created_at > now() - interval '1 hour' fresh`)).rows);
    for (const n of rows.filter((r) => r.fresh)) {
      await sendToUser(n.user_id, { title: 'SRU News Hub', body: n.text, url: urlOf(n.kind, n.ref_id), tag: `${n.kind}:${n.ref_id ?? n.id}` });
    }
  } finally {
    pushing = false;
  }
}

// ---- Routes (any university account: the notices are calendar, requests and feedback) ----
export const router = Router();
const pushTest = limit('pushTest', { max: 5, windowMs: 10 * 60 * 1000 });
const MAX_DEVICES = 10;

function subscription(b) {
  const endpoint = b?.endpoint, p256dh = b?.keys?.p256dh, auth = b?.keys?.auth;
  if (!allowedEndpoint(endpoint)) throw new HttpError(400, 'เบราว์เซอร์นี้ใช้การแจ้งเตือนกับระบบไม่ได้');
  const okKey = (s, len) => typeof s === 'string' && /^[\w-]+=*$/.test(s) && s.length < 200 && unb64u(s).length === len;
  if (!okKey(p256dh, 65) || unb64u(p256dh)[0] !== 4 || !okKey(auth, 16)) throw new HttpError(400, 'ข้อมูลการแจ้งเตือนไม่ถูกต้อง');
  return { endpoint, p256dh, auth };
}

router.get('/push/key', requireBackOffice, async (req, res) => {
  const { n } = await one('select count(*)::int n from push_subscriptions where user_id = $1', [req.user.id]);
  res.json({ publicKey: (await vapidKeys()).publicKey, devices: n });
});
router.post('/push/subscribe', requireBackOffice, async (req, res) => {
  const s = subscription(req.body);
  const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 300) : null;
  const added = await tx(async (c) => {
    // The same browser signed in with another account now belongs to that account
    const r = (await c.query(`insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, session_id) values ($1, $2, $3, $4, $5, $6)
      on conflict (endpoint) do update set user_id = $1, p256dh = $3, auth = $4, user_agent = $5, session_id = $6
      returning (xmax = 0) inserted`, [req.user.id, s.endpoint, s.p256dh, s.auth, ua, req.sessionId || null])).rows[0];
    await c.query(`delete from push_subscriptions where user_id = $1 and id not in (
      select id from push_subscriptions where user_id = $1 order by created_at desc limit ${MAX_DEVICES})`, [req.user.id]);
    if (r.inserted) await audit(c, req.user, 'push.subscribe', req.user.email, 'เปิดแจ้งเตือนบนอุปกรณ์', { userAgent: ua });
    return r.inserted;
  });
  res.status(added ? 201 : 200).json({ ok: true });
});
// Is this browser on for the signed-in account? (push.js on each page load.) Yes: it now follows this sign-in for logout.
router.post('/push/check', requireBackOffice, async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > 1000) throw new HttpError(400, 'ข้อมูลการแจ้งเตือนไม่ถูกต้อง');
  const r = await one('update push_subscriptions set session_id = $3 where endpoint = $1 and user_id = $2 returning id', [endpoint, req.user.id, req.sessionId || null]);
  res.json({ on: !!r });
});
router.post('/push/unsubscribe', requireBackOffice, async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > 1000) throw new HttpError(400, 'ข้อมูลการแจ้งเตือนไม่ถูกต้อง');
  await tx(async (c) => {
    const r = await c.query('delete from push_subscriptions where endpoint = $1 and user_id = $2', [endpoint, req.user.id]);
    if (r.rowCount) await audit(c, req.user, 'push.unsubscribe', req.user.email, 'ปิดแจ้งเตือนบนอุปกรณ์');
  });
  res.json({ ok: true });
});
router.post('/push/test', requireBackOffice, pushTest, async (req, res) => {
  const r = await sendToUser(req.user.id, { title: 'SRU News Hub', body: 'ทดสอบการแจ้งเตือน: ถ้าเห็นข้อความนี้ แปลว่าใช้งานได้แล้ว', url: '/calendar.html', tag: 'test' });
  if (!r.devices) throw new HttpError(400, 'ยังไม่ได้เปิดการแจ้งเตือนบนอุปกรณ์ใด');
  res.json(r);
});
