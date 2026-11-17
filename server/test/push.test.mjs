// Web Push: RFC 8291 encryption (test vector), the VAPID signature, which push services are allowed,
// and who may turn it on (external accounts never), with every change in audit_log.
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { query } from '../db.mjs';
import { allowedEndpoint, encrypt, urlOf, vapidHeader, vapidKeys } from '../push.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { anon, login } from './helpers.mjs';

const u = (s) => Buffer.from(s, 'base64url');
// RFC 8291 Appendix A
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
// What the browser does with a message (for a round trip with fresh keys)
function decrypt(body, uaPrivate, auth) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), data = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const hmac = (k, d) => createHmac('sha256', k).update(d).digest();
  const ikm = hmac(hmac(auth, ecdh.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const d = createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
  d.setAuthTag(data.subarray(-16));
  const out = Buffer.concat([d.update(data.subarray(0, -16)), d.final()]);
  assert.equal(out.at(-1), 2);
  return out.subarray(0, -1).toString();
}

describe('การเข้ารหัสและลายเซ็น', () => {
  test('ตรงกับตัวอย่างใน RFC 8291', () => {
    const body = encrypt({ p256dh: RFC.uaPublic, auth: RFC.auth }, RFC.plaintext, { salt: u(RFC.salt), asPrivate: u(RFC.asPrivate) });
    assert.equal(body.toString('base64url'), RFC.body);
    assert.equal(decrypt(body, u(RFC.uaPrivate), u(RFC.auth)), RFC.plaintext);
  });
  test('กุญแจใหม่ทุกครั้ง ถอดกลับได้ภาษาไทย', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const text = JSON.stringify({ body: 'คุณได้รับมอบหมายงาน: ถ่ายภาพพิธีไหว้ครู' });
    const body = encrypt({ p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }, text);
    assert.equal(decrypt(body, ua.getPrivateKey(), auth), text);
  });
  test('ลายเซ็น VAPID ตรวจได้ด้วยกุญแจสาธารณะ และกุญแจคงเดิม', async () => {
    const { publicKey } = await vapidKeys();
    assert.equal(u(publicKey).length, 65);
    const h = await vapidHeader('https://fcm.googleapis.com/fcm/send/abc');
    const [, jwt, k] = h.match(/^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/);
    assert.equal(k, publicKey);
    const [head, claims, sig] = jwt.split('.');
    assert.equal(JSON.parse(u(claims).toString()).aud, 'https://fcm.googleapis.com');
    const pub = u(publicKey);
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, u(sig)));
    const row = (await query(`select value from settings where key = 'push.vapid'`)).rows[0];
    assert.equal(row.value.publicKey, publicKey);
  });
  test('ส่งได้เฉพาะบริการแจ้งเตือนของเบราว์เซอร์', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-sg2p.notify.windows.com/w/?token=x']) assert.ok(allowedEndpoint(ok), ok);
    for (const bad of ['http://fcm.googleapis.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.com/x', 'https://evilpush.apple.com.x.io/', 'https://fcm.googleapis.com:8443/x', 'https://a@fcm.googleapis.com/x', 'ftp://x', 42]) assert.ok(!allowedEndpoint(bad), String(bad));
  });
  test('แตะการแจ้งเตือนแล้วไปหน้าที่ถูกต้อง', () => {
    assert.equal(urlOf('event.assigned', 'e1'), '/calendar.html?id=e1');
    assert.equal(urlOf('request.new', 'r 1'), '/requests.html?id=r%201');
    assert.equal(urlOf('access.new', '3'), '/requests.html');
    assert.equal(urlOf('feedback.new', '3'), '/pr.html?feedback');
  });
});

describe('เปิด/ปิดการแจ้งเตือน', () => {
  let snap, staff, pr, external;
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const sub = (tag) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/test-${tag}-${Date.now()}`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } });
  before(async () => {
    snap = await snapshot();
    [staff, pr, external] = await Promise.all(['staff', 'pr', 'external'].map(login));
  });
  after(async () => {
    await query(`delete from push_subscriptions where endpoint like 'https://fcm.googleapis.com/fcm/send/test-%'`);
    await restore(snap);
  });

  test('บัญชีภายนอกและผู้ไม่ได้เข้าสู่ระบบใช้ไม่ได้', async () => {
    /** @type {[string, string, any?][]} */
    const calls = [['GET', '/api/push/key'], ['POST', '/api/push/subscribe', sub('x')], ['POST', '/api/push/unsubscribe', { endpoint: 'x' }], ['POST', '/api/push/test', {}]];
    for (const [method, path, body] of calls) {
      assert.equal((await external.call(method, path, body)).status, 403, path);
      assert.equal((await anon.call(method, path, body)).status, 401, path);
    }
  });
  test('เปิด ปิด และบันทึกใน audit_log', async () => {
    const k = await staff.call('GET', '/api/push/key');
    assert.equal(k.status, 200);
    assert.equal(u(k.body.publicKey).length, 65);
    const s = sub('staff');
    assert.equal((await staff.call('POST', '/api/push/subscribe', s)).status, 201);
    assert.equal((await staff.call('POST', '/api/push/subscribe', s)).status, 200); // again: no second row
    assert.equal((await query('select count(*)::int n from push_subscriptions where endpoint = $1', [s.endpoint])).rows[0].n, 1);
    assert.equal((await staff.call('GET', '/api/push/key')).body.devices >= 1, true);
    // Someone else cannot turn off this browser
    await pr.call('POST', '/api/push/unsubscribe', { endpoint: s.endpoint });
    assert.equal((await query('select count(*)::int n from push_subscriptions where endpoint = $1', [s.endpoint])).rows[0].n, 1);
    assert.equal((await staff.call('POST', '/api/push/unsubscribe', { endpoint: s.endpoint })).status, 200);
    assert.equal((await query('select count(*)::int n from push_subscriptions where endpoint = $1', [s.endpoint])).rows[0].n, 0);
    const acts = (await query(`select action from audit_log where action like 'push.%' and at > now() - interval '1 minute' order by id`)).rows.map((r) => r.action);
    assert.ok(acts.includes('push.subscribe') && acts.includes('push.unsubscribe'));
  });
  test('ออกจากระบบแล้ว อุปกรณ์นั้นไม่ได้รับแจ้งเตือนอีก', async () => {
    const me = await login('staff');
    const s = sub('logout');
    assert.equal((await me.call('POST', '/api/push/subscribe', s)).status, 201);
    assert.deepEqual((await me.call('POST', '/api/push/check', { endpoint: s.endpoint })).body, { on: true });
    assert.equal((await me.call('POST', '/api/auth/logout', {})).status, 200);
    assert.equal((await query('select count(*)::int n from push_subscriptions where endpoint = $1', [s.endpoint])).rows[0].n, 0);
    // The next person on this computer: the browser is told to turn off
    assert.deepEqual((await pr.call('POST', '/api/push/check', { endpoint: s.endpoint })).body, { on: false });
  });
  test('อุปกรณ์ของคนอื่นถือว่าปิดสำหรับบัญชีนี้', async () => {
    const s = sub('other');
    assert.equal((await staff.call('POST', '/api/push/subscribe', s)).status, 201);
    assert.deepEqual((await pr.call('POST', '/api/push/check', { endpoint: s.endpoint })).body, { on: false });
    assert.equal((await external.call('POST', '/api/push/check', { endpoint: s.endpoint })).status, 403);
    assert.equal((await staff.call('POST', '/api/push/check', { endpoint: 42 })).status, 400);
  });
  test('ข้อมูลผิดถูกปฏิเสธ', async () => {
    const s = sub('bad');
    for (const body of [{ ...s, endpoint: 'https://example.com/x' }, { ...s, keys: { ...s.keys, auth: 'short' } }, { ...s, keys: { ...s.keys, p256dh: 'AAAA' } }, {}, { endpoint: s.endpoint }]) {
      assert.equal((await staff.call('POST', '/api/push/subscribe', body)).status, 400, JSON.stringify(body));
    }
  });
});
