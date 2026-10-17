// Digests (phase 8) and email notifications (phase 9). Needs the sample data: npm run db:seed
// What the tests change is put back afterwards (cleanup.mjs).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { query } from '../db.mjs';
import { daily } from '../notify.mjs';
import { load as loadSettings } from '../settings.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { BASE, ID_STAFF, anon, form, img, login } from './helpers.mjs';

let pr, staff, admin, snap, open, upcoming, published;
before(async () => {
  snap = await snapshot();
  await loadSettings();
  [pr, staff, admin] = await Promise.all(['pr', 'staff', 'admin'].map(login));
  await staff.call('PUT', '/api/me/profile', { ...ID_STAFF, unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'นักประชาสัมพันธ์', consent: true });
  const list = (await pr.call('GET', '/api/pr/digests')).body.items;
  open = list.find((d) => d.status === 'review' && d.open);
  upcoming = list.find((d) => d.status === 'review' && !d.open);
  published = list.find((d) => d.status === 'published');
  assert.ok(open && upcoming && published, 'run npm run db:seed first');
});
after(async () => { await restore(snap); });

const upload = (path, fields, files) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [k, [name, buf, type]] of Object.entries(files)) fd.append(k, new Blob([buf], { type }), name);
  return pr.call('PUT', path, fd);
};
// A small valid PDF (3 empty pages)
function tinyPdf(pages) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ')}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>')];
  let out = '%PDF-1.4\n';
  const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}

describe('digests: reading', () => {
  test('the shelf lists published issues; drafts only as placeholders', async () => {
    const r = await anon.call('GET', '/api/digests');
    assert.equal(r.status, 200);
    assert.ok(r.body.published.some((d) => d.id === published.id && d.count > 0 && d.pages >= 4));
    assert.ok(r.body.waiting.some((d) => d.id === open.id));
    assert.equal(r.body.waiting[0].groups, undefined);
  });
  test('a draft is not readable outside the PR team', async () => {
    assert.equal((await anon.call('GET', `/api/digests/${open.id}`)).status, 404);
    assert.equal((await staff.call('GET', `/api/digests/${open.id}`)).status, 404);
    assert.equal((await pr.call('GET', `/api/digests/${open.id}`)).status, 200);
    const pub = await anon.call('GET', `/api/digests/${published.id}`);
    assert.equal(pub.status, 200);
    assert.ok(pub.body.stories.length > 0 && pub.body.groups.length > 0);
  });
  test('the studio is for the PR team only', async () => {
    assert.equal((await staff.call('GET', '/api/pr/digests')).status, 403);
    assert.equal((await anon.call('GET', '/api/pr/digests')).status, 401);
  });
});

describe('digests: the studio', () => {
  test('auto layout; taking a story out leaves it under "not in the book"', async () => {
    const r = (await pr.call('GET', `/api/pr/digests/${open.id}`)).body;
    assert.ok(r.groups.length > 0);
    const [g] = r.groups;
    const out = g.ids[0];
    const saved = await pr.call('PUT', `/api/pr/digests/${open.id}`, { mode: 'auto', groups: [{ cat: g.cat, ids: g.ids.slice(1) }, ...r.groups.slice(1)] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.ok(saved.body.excluded.includes(out));
    assert.ok(saved.body.digest.edited);
  });
  test('books that break the rules are refused', async () => {
    const r = (await pr.call('GET', `/api/pr/digests/${open.id}`)).body;
    const foreign = (await pr.call('GET', `/api/pr/digests/${published.id}`)).body.stories[0].id;
    assert.equal((await pr.call('PUT', `/api/pr/digests/${open.id}`, { mode: 'auto', groups: [{ cat: r.stories[0].cat, ids: [foreign] }] })).status, 400);
    const s = r.stories[0];
    assert.equal((await pr.call('PUT', `/api/pr/digests/${open.id}`, { mode: 'auto', groups: [{ cat: 'ไม่ใช่ประเภทนี้', ids: [s.id] }] })).status, 400);
    assert.equal((await pr.call('PUT', `/api/pr/digests/${open.id}`, { mode: 'auto', groups: [{ cat: s.cat, ids: [s.id, s.id] }] })).status, 400);
  });
  test('reset goes back to the automatic layout', async () => {
    const r = await pr.call('POST', `/api/pr/digests/${open.id}/reset`);
    assert.equal(r.status, 200);
    assert.equal(r.body.digest.edited, false);
  });
  test('cover: JPG/PNG only, private until published', async () => {
    assert.equal((await upload(`/api/pr/digests/${open.id}/cover`, {}, { file: ['x.pdf', Buffer.from('%PDF-1.4'), 'application/pdf'] })).status, 400);
    const r = await upload(`/api/pr/digests/${open.id}/cover`, {}, { file: ['ปก.jpg', await img('#7A3CE2', 1240, 1754), 'image/jpeg'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.digest.cover.w, 1240);
    const url = r.body.digest.cover.url;
    assert.equal((await fetch(BASE + url)).status, 404);
    assert.equal((await pr.call('GET', url)).status, 200);
  });
  test('cannot approve before the issue opens', async () => {
    assert.equal((await pr.call('POST', `/api/pr/digests/${upcoming.id}/publish`)).status, 409);
  });
  test('approve: on the shelf, files public; withdraw puts it back', async () => {
    const r = await pr.call('POST', `/api/pr/digests/${open.id}/publish`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.digest.status, 'published');
    assert.ok((await anon.call('GET', '/api/digests')).body.published.some((d) => d.id === open.id));
    const cover = await fetch(BASE + r.body.digest.cover.url);
    assert.equal(cover.status, 200);
    assert.match(cover.headers.get('cache-control'), /public/);
    assert.equal((await pr.call('PUT', `/api/pr/digests/${open.id}`, { mode: 'auto' })).status, 409);
    const back = await pr.call('POST', `/api/pr/digests/${open.id}/unpublish`);
    assert.equal(back.body.digest.status, 'review');
    assert.equal((await anon.call('GET', `/api/digests/${open.id}`)).status, 404);
  });
  test('own PDF: checked, counted, downloadable once published', async () => {
    assert.equal((await upload(`/api/pr/digests/${open.id}/pdf`, { pages: '3' }, { file: ['a.pdf', Buffer.from('not a pdf'), 'application/pdf'] })).status, 400);
    assert.equal((await upload(`/api/pr/digests/${open.id}/pdf`, { pages: '13' }, { file: ['a.pdf', tinyPdf(13), 'application/pdf'] })).status, 400);
    const shelf = await sharp({ create: { width: 620, height: 877, channels: 3, background: '#DE142A' } }).jpeg().toBuffer();
    const r = await upload(`/api/pr/digests/${open.id}/pdf`, { pages: '3', notA4: '0' }, { file: ['เล่ม.pdf', tinyPdf(3), 'application/pdf'], shelf: ['shelf.jpg', shelf, 'image/jpeg'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.digest.pdf.pages, 3);
    assert.ok(r.body.digest.shelf);
    await pr.call('PUT', `/api/pr/digests/${open.id}`, { mode: 'pdf' });
    await pr.call('POST', `/api/pr/digests/${open.id}/publish`);
    const pub = (await anon.call('GET', '/api/digests')).body.published.find((d) => d.id === open.id);
    assert.equal(pub.pages, 3);
    assert.equal(pub.count, null);
    const dl = await fetch(`${BASE}${pub.pdf.url}?download=1`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), /attachment/);
    await pr.call('POST', `/api/pr/digests/${open.id}/unpublish`);
  });
  test('internal stories are in the book only for readers who may see them', async () => {
    // The issue that is still being made has the staff-only sample story; open it for this test
    const r = (await pr.call('GET', `/api/pr/digests/${upcoming.id}`)).body;
    const internal = r.stories.find((s) => s.internal);
    if (!internal) return; // sample data without one in this range
    await query("update digests set drafted_at = now() - interval '1 hour' where id = $1", [upcoming.id]);
    assert.equal((await pr.call('POST', `/api/pr/digests/${upcoming.id}/publish`)).status, 200);
    const outside = (await anon.call('GET', `/api/digests/${upcoming.id}`)).body;
    assert.ok(!outside.stories.some((s) => s.id === internal.id));
    // Staff-only or student-only: one of the two groups sees it, the other does not
    const student = await login('student');
    const views = [(await staff.call('GET', `/api/digests/${upcoming.id}`)).body, (await student.call('GET', `/api/digests/${upcoming.id}`)).body];
    const seen = views.filter((v) => v.stories.some((s) => s.id === internal.id));
    assert.ok(seen.length >= 1);
    assert.ok(seen.every((v) => v.digest.count > outside.digest.count));
  });
});

describe('email notifications', () => {
  const NEWS = {
    type: 'news', title: 'ทดสอบอีเมลแจ้งเตือน', lead: 'สรุป', eventDate: '2026-10-10', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
    contentMode: 'own', body: 'ก'.repeat(160), audience: ['public'], consent: true,
  };
  let ref;
  const mails = async (kind, r = ref) => (await query('select * from email_outbox where kind = $1 and ref = $2 order by id', [kind, r])).rows;

  test('new work → the PR team', async () => {
    const r = await staff.call('POST', '/api/submissions', form(NEWS, { photo: [['a.jpg', await img('#d22'), 'image/jpeg']] }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ref = r.body.submission.ref;
    const to = (await mails('pr.new')).map((m) => m.to_email);
    assert.ok(to.includes('pr@sru.ac.th'));
    assert.ok(!to.includes('user@sru.ac.th'));
  });
  test('asked to fix → the sender, with the PR message and a link to edit', async () => {
    await pr.call('POST', `/api/pr/submissions/${ref}/status`, { status: 'revise', message: 'ขอภาพเพิ่ม 2 ภาพ' });
    const [m] = await mails('submission.status');
    assert.equal(m.to_email, 'user@sru.ac.th');
    assert.match(m.body, /ขอภาพเพิ่ม 2 ภาพ/);
    assert.match(m.body, new RegExp(`submit\\.html\\?edit=${ref}`));
    assert.match(m.subject, /^\[ข่าว มรส\.\]/);
  });
  test('a PR message → the sender; a sender message → the PR team', async () => {
    await pr.call('POST', `/api/pr/submissions/${ref}/messages`, { text: 'ส่งได้ภายในวันศุกร์' });
    assert.equal((await mails('submission.message')).length, 1);
    await staff.call('POST', `/api/submissions/${ref}/messages`, { text: 'รับทราบครับ' });
    assert.ok((await mails('pr.message')).some((m) => m.to_email === 'pr@sru.ac.th'));
  });
  test('turned off → no email', async () => {
    const prefs = (await staff.call('GET', '/api/me/notify')).body;
    assert.deepEqual(prefs.prefs.map((p) => p.key), ['status', 'message']);
    await staff.call('PUT', '/api/me/notify', { status: false });
    await pr.call('POST', `/api/pr/submissions/${ref}/status`, { status: 'rejected', message: 'ซ้ำกับข่าวเดิม' });
    assert.equal((await mails('submission.status')).length, 1);
    assert.equal((await staff.call('GET', '/api/me/notify')).body.prefs.find((p) => p.key === 'status').on, false);
  });
  test('morning summary and digest reminders go to the PR team', async () => {
    const before = (await query('select max(id) id from email_outbox')).rows[0].id || 0;
    await daily();
    const rows = (await query('select * from email_outbox where id > $1', [before])).rows;
    assert.ok(rows.some((m) => m.kind === 'pr.daily' && m.to_email === 'pr@sru.ac.th'));
    assert.ok(rows.some((m) => m.kind === 'digest.reminder' && m.ref === open.id));
    const studio = (await pr.call('GET', `/api/pr/digests/${open.id}`)).body.digest;
    assert.ok(studio.reminders >= 1);
  });
  test('admins see the outbox and can send a test email', async () => {
    assert.equal((await staff.call('GET', '/api/admin/mail')).status, 403);
    assert.equal((await admin.call('POST', '/api/admin/mail/test')).status, 201);
    const r = (await admin.call('GET', '/api/admin/mail')).body;
    assert.equal(typeof r.smtp, 'boolean');
    const t = r.items.find((m) => m.kind === 'test');
    assert.equal(t.to_email, 'admin@sru.ac.th');
    const one = (await admin.call('GET', `/api/admin/mail/${t.id}`)).body.mail;
    assert.match(one.html, /<!doctype html>/);
  });
});
