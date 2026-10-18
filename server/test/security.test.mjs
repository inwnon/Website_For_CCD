// Security (phase 10): headers, rate limits, file content, access between accounts, CSRF, paths
// and PDPA: my data, deletion requests, retention of files of work never published.
// What the tests create is removed afterwards (cleanup.mjs).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { query } from '../db.mjs';
import { abs } from '../files.mjs';
import { purge } from '../privacy.mjs';
import { load as loadSettings } from '../settings.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { BASE, ID_OTHER, ID_STAFF, anon, form, img, login, request } from './helpers.mjs';

const NEWS = {
  type: 'news', title: 'ทดสอบความปลอดภัย', lead: 'สรุป', eventDate: '2026-10-10', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
  contentMode: 'own', body: 'ก'.repeat(160), audience: ['public'], consent: true,
};
const photoForm = (name, buf, type) => { const fd = new FormData(); fd.append('photo', new Blob([buf], { type }), name); return fd; };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF');
let staff, student, pr, admin, snap, retentionBefore;
before(async () => {
  snap = await snapshot();
  await loadSettings();
  [staff, student, pr, admin] = await Promise.all(['staff', 'student', 'pr', 'admin'].map(login));
  await staff.call('PUT', '/api/me/profile', { ...ID_STAFF, unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'นักประชาสัมพันธ์', consent: true });
  retentionBefore = (await admin.call('GET', '/api/admin/settings')).body.settings.retention;
});
// Through the API too, so the server's settings cache matches the database again
after(async () => { await admin.call('PUT', '/api/admin/settings/retention', { value: retentionBefore }); await restore(snap); });

describe('headers', () => {
  test('pages and the API send CSP and the other security headers', async () => {
    for (const path of ['/index.html', '/api/news?limit=1']) {
      const r = await fetch(BASE + path);
      const csp = r.headers.get('content-security-policy');
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /object-src 'none'/);
      assert.match(csp, /frame-ancestors 'self'/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(r.headers.get('permissions-policy'));
    }
  });
  test('HSTS only over HTTPS', async () => {
    assert.equal((await fetch(`${BASE}/index.html`)).headers.get('strict-transport-security'), null);
  });
});

describe('rate limits', () => {
  test('too many sign-in attempts from one address → 429 with Retry-After', async () => {
    let last;
    for (let i = 0; i < 32; i++) last = await request('POST', '/api/auth/google', { credential: 'x' });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
    assert.match(last.body.error, /บ่อยเกินไป/);
  });
});

describe('file content must match the name', () => {
  const attach = (files) => staff.call('POST', '/api/submissions', form({ ...NEWS, contentMode: 'pr', body: '' }, { photo: [['a.jpg', files.photo, 'image/jpeg']], attach: [files.attach] }));
  test('a program renamed to .pdf is refused', async () => {
    const r = await attach({ photo: await img('#468'), attach: ['คำกล่าว.pdf', Buffer.from('MZ\x90\x00 this is an exe'), 'application/pdf'] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /ไม่ใช่ไฟล์ PDF จริง/);
  });
  test('a JPEG named .png is refused; real files pass', async () => {
    const bad = await staff.call('POST', '/api/submissions', form(NEWS, { photo: [['a.png', await img('#468'), 'image/png']] }));
    assert.equal(bad.status, 400);
    const ok = await attach({ photo: await img('#468'), attach: ['คำกล่าว.pdf', PDF, 'application/pdf'] });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const docx = await attach({ photo: await img('#468'), attach: ['กำหนดการ.docx', Buffer.from('PK\x03\x04 rest of a zip'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] });
    assert.equal(docx.status, 201);
  });
});

describe('access between accounts', () => {
  let ref, fileId;
  before(async () => {
    const r = await staff.call('POST', '/api/submissions', form({ ...NEWS, title: '<img src=x onerror=alert(1)> งานของบุคลากร' }, { photo: [['a.jpg', await img('#468'), 'image/jpeg']] }));
    ref = r.body.submission.ref;
    fileId = r.body.submission.files[0].id;
  });
  test('another account cannot see, change or message my work', async () => {
    assert.equal((await student.call('GET', `/api/submissions/${ref}`)).status, 404);
    assert.equal((await student.call('GET', `/api/files/${fileId}`)).status, 404);
    assert.equal((await student.call('POST', `/api/submissions/${ref}/messages`, { text: 'แอบส่ง' })).status, 404);
    assert.equal((await student.call('PUT', `/api/submissions/${ref}`, form(NEWS))).status, 404);
    assert.ok(!(await student.call('GET', '/api/submissions')).body.submissions.some((s) => s.ref === ref));
    assert.equal((await anon.call('GET', `/api/files/${fileId}`)).status, 401);
  });
  test('back-office routes need the right role', async () => {
    assert.equal((await staff.call('GET', '/api/pr/submissions')).status, 403);
    assert.equal((await staff.call('POST', `/api/pr/submissions/${ref}/status`, { status: 'rejected', message: 'x' })).status, 403);
    assert.equal((await pr.call('GET', '/api/admin/settings')).status, 403);
    assert.equal((await pr.call('GET', '/api/admin/requests')).status, 403);
    assert.equal((await staff.call('GET', '/api/reports')).status, 403);
    assert.equal((await anon.call('GET', '/api/me/data')).status, 401);
  });
  test('script in a title is stored as text and comes back as text', async () => {
    const s = (await staff.call('GET', `/api/submissions/${ref}`)).body.submission;
    assert.equal(s.title, '<img src=x onerror=alert(1)> งานของบุคลากร');
  });
  test('changes from another website are refused (CSRF)', async () => {
    const r = await staff.call('POST', `/api/submissions/${ref}/messages`, { text: 'จากเว็บอื่น' }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
  });
  test('server files, uploads and paths outside the site are not served', async () => {
    for (const p of ['/.env', '/server/index.mjs', '/package.json', '/uploads/tmp', '/node_modules/express/package.json', '/%2e%2e/.env', '/media/..%2f..%2f.env', `/media/${'0'.repeat(8)}-0000-0000-0000-000000000000/x.webp`]) {
      const r = await fetch(BASE + p);
      assert.ok(r.status === 404 || r.status === 400, `${p} → ${r.status}`);
    }
  });
});

describe('PDPA: my data', () => {
  test('download my data: my work only, nothing of others', async () => {
    const r = await staff.call('GET', '/api/me/data');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment/);
    const data = r.body;
    assert.equal(data.account.email, 'user@sru.ac.th');
    assert.ok(data.submissions.length >= 1);
    assert.ok(data.submissions.every((s) => s.files.every((f) => !('path' in f))));
    const theirs = (await student.call('GET', '/api/me/data')).body;
    assert.ok(!theirs.submissions.some((s) => s.title.includes('งานของบุคลากร')));
  });

  test('ask to delete → admin erases: unpublished work gone, signed out, the address can start over', async () => {
    await student.call('PUT', '/api/me/profile', { ...ID_OTHER, unit: 'คณะวิทยาศาสตร์และเทคโนโลยี', major: 'เทคโนโลยีสารสนเทศ', track: 'มัลติมีเดีย', year: 2, consent: true });
    const sent = await student.call('POST', '/api/submissions', form({ ...NEWS, unit: 'คณะวิทยาศาสตร์และเทคโนโลยี' }, { photo: [['a.jpg', await img('#468'), 'image/jpeg']] }));
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const sub = (await query('select id from submissions where ref = $1', [sent.body.submission.ref])).rows[0];
    const pic = await student.call('PUT', '/api/me/photo', photoForm('me.jpg', await img('#a3c', 600, 400), 'image/jpeg'));
    assert.equal(pic.status, 200);
    const picPath = (await query('select photo_path from users where id = $1', [pic.body.user.id])).rows[0].photo_path;
    const r = await student.call('POST', '/api/me/delete-request', { reason: 'จบการศึกษาแล้ว' });
    assert.equal(r.status, 201);
    assert.equal((await student.call('POST', '/api/me/delete-request', {})).status, 409);
    const list = (await admin.call('GET', '/api/admin/requests')).body.items;
    const req = list.find((x) => x.id === r.body.request.id);
    assert.equal(req.status, 'pending');
    assert.equal((await admin.call('POST', `/api/admin/requests/${req.id}/erase`, {})).status, 200);
    // Signed out, the work and its folder are gone, nothing personal left on the row
    assert.equal((await student.call('GET', '/api/me/data')).status, 401);
    assert.equal((await query('select 1 from submissions where id = $1', [sub.id])).rowCount, 0);
    assert.ok(!existsSync(abs(`submissions/${sub.id}`)));
    assert.ok(!existsSync(abs(picPath)), 'profile photo removed');
    const row = (await query('select email, name, unit, erased_at from users where id = (select user_id from data_requests where id = $1)', [req.id])).rows[0];
    assert.match(row.email, /@deleted\.invalid$/);
    assert.equal(row.name, '');
    assert.equal(row.unit, null);
    assert.ok(row.erased_at);
    // The person is told by email
    assert.ok((await query(`select 1 from email_outbox where kind = 'privacy.done' and to_email = 'user@student.sru.ac.th'`)).rowCount >= 1);
    // Signing in again starts a new account
    const again = await login('student');
    assert.equal((await again.call('GET', '/api/me')).body.user.onboarded, false);
  });

  test('a request can be cancelled; admins must give a reason to refuse', async () => {
    const r = await staff.call('POST', '/api/me/delete-request', {});
    assert.equal((await staff.call('DELETE', '/api/me/delete-request')).body.request.status, 'cancelled');
    const r2 = await staff.call('POST', '/api/me/delete-request', {});
    assert.equal((await admin.call('POST', `/api/admin/requests/${r2.body.request.id}/reject`, {})).status, 400);
    assert.equal((await admin.call('POST', `/api/admin/requests/${r2.body.request.id}/reject`, { note: 'มีข่าวที่อยู่ระหว่างตรวจสอบ' })).status, 200);
    assert.equal((await staff.call('GET', '/api/me/delete-request')).body.request.status, 'rejected');
    assert.ok(r.status === 201);
  });
});

describe('profile photo', () => {
  test('upload: square 512px WebP without EXIF, shown instead of the Google photo; signing in again keeps it', async () => {
    const r = await staff.call('PUT', '/api/me/photo', photoForm('ฉัน.jpg', await img('#3a6', 1200, 800), 'image/jpeg'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.ownPhoto, true);
    assert.match(r.body.user.avatarUrl, /^\/api\/avatars\/[0-9a-f-]{36}\.webp$/);
    const file = await staff.call('GET', r.body.user.avatarUrl);
    assert.equal(file.status, 200);
    const meta = await sharp(file.body).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height, meta.exif], ['webp', 512, 512, undefined]);
    assert.equal((await anon.call('GET', r.body.user.avatarUrl)).status, 401, 'signed-in users only');
    await login('staff');
    assert.equal((await staff.call('GET', '/api/me')).body.user.avatarUrl, r.body.user.avatarUrl);
  });
  test('a new photo replaces the old file; wrong files are refused', async () => {
    const before = (await staff.call('GET', '/api/me')).body.user.avatarUrl;
    const r = await staff.call('PUT', '/api/me/photo', photoForm('new.png', await sharp({ create: { width: 300, height: 300, channels: 3, background: '#c33' } }).png().toBuffer(), 'image/png'));
    assert.equal(r.status, 200);
    assert.notEqual(r.body.user.avatarUrl, before);
    assert.ok(!existsSync(abs(before.replace('/api/', ''))), 'old file removed');
    assert.equal((await staff.call('PUT', '/api/me/photo', photoForm('a.pdf', PDF, 'application/pdf'))).status, 400);
    assert.equal((await staff.call('PUT', '/api/me/photo', photoForm('fake.jpg', Buffer.from('MZ not a picture'), 'image/jpeg'))).status, 400);
    assert.equal((await staff.call('PUT', '/api/me/photo', new FormData())).status, 400);
    assert.equal((await anon.call('PUT', '/api/me/photo', photoForm('a.jpg', await img('#123', 100, 100), 'image/jpeg'))).status, 401);
    assert.equal((await staff.call('GET', '/api/avatars/..%2F..%2F.env')).status, 404);
  });
  test('delete: back to the Google photo (none for dev accounts), file removed', async () => {
    const was = (await staff.call('GET', '/api/me')).body.user.avatarUrl;
    const r = await staff.call('DELETE', '/api/me/photo');
    assert.equal(r.status, 200);
    assert.equal(r.body.user.ownPhoto, false);
    assert.equal(r.body.user.avatarUrl, null);
    assert.ok(!existsSync(abs(was.replace('/api/', ''))));
  });
});

describe('PDPA: retention', () => {
  test('files of work never published are removed after the retention period; published work keeps them', async () => {
    const r = await staff.call('POST', '/api/submissions', form({ ...NEWS, title: 'งานที่ไม่ได้เผยแพร่' }, { photo: [['a.jpg', await img('#468'), 'image/jpeg']] }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { ref } = r.body.submission;
    await pr.call('POST', `/api/pr/submissions/${ref}/status`, { status: 'rejected' }); // ลบข่าว: hidden, kept
    const id = (await query('select id from submissions where ref = $1', [ref])).rows[0].id;
    assert.ok(existsSync(abs(`submissions/${id}`)));
    assert.equal(await purge() >= 0, true);
    assert.ok(existsSync(abs(`submissions/${id}`)), 'not yet: still within the period');
    // Last activity 200 days ago
    await query(`update submission_events set at = now() - interval '200 days' where submission_id = $1`, [id]);
    assert.ok(await purge() >= 1);
    assert.ok(!existsSync(abs(`submissions/${id}`)));
    const s = (await pr.call('GET', `/api/submissions/${ref}`)).body.submission;
    assert.equal(s.files.length, 0);
    assert.ok(s.filesRemovedAt);
  });
  test('the period is a setting (30–3650 days) and is shown to readers', async () => {
    assert.equal((await admin.call('PUT', '/api/admin/settings/retention', { value: { days: 10 } })).status, 400);
    assert.equal((await admin.call('PUT', '/api/admin/settings/retention', { value: { days: 365 } })).status, 200);
    assert.match(await (await fetch(`${BASE}/site-config.js`)).text(), /"retentionDays":365/);
  });
});
