// Drafts (drafts.mjs) and what came with them on submit.html: the order of the photos (first = cover), name prefixes,
// headline 180 / lead 250. What the tests create is removed afterwards (cleanup.mjs).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { query } from '../db.mjs';
import { abs } from '../files.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { ID_OTHER, ID_STAFF, anon, form, img, login } from './helpers.mjs';

const NEWS = {
  type: 'news', credit: 'งานประชาสัมพันธ์ทดสอบ', title: 'ทดสอบร่าง', lead: 'สรุป', eventDate: '2026-10-10', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
  contentMode: 'own', body: 'ก'.repeat(160), audience: ['public'], consent: true,
};
const jpg = async (name, color) => [name, await img(color, 800, 600), 'image/jpeg'];
let staff, student, pr, snap;
before(async () => {
  snap = await snapshot();
  [staff, student, pr] = await Promise.all([login('staff'), login('student'), login('pr')]);
  await staff.call('PUT', '/api/me/profile', { ...ID_STAFF, unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'นักประชาสัมพันธ์', consent: true });
  await student.call('PUT', '/api/me/profile', { ...ID_OTHER, unit: 'คณะครุศาสตร์', major: 'คณิตศาสตร์', year: 2, consent: true });
});
after(async () => { await restore(snap); });

describe('drafts', () => {
  test('a draft keeps text and photos, needs nothing filled in, and only its sender sees it', async () => {
    const r = await staff.call('POST', '/api/drafts', form({ type: 'news', title: 'ร่างแรก', chairPrefix: 'ผศ.ดร.', chairName: 'สมชาย', guests: [{ prefix: 'นาย', name: 'สมศักดิ์', pos: 'นายก' }], body: 'สั้น' },
      { photo: [await jpg('a.jpg', '#c00'), await jpg('b.jpg', '#0c0')] }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.draft.id;
    assert.deepEqual(r.body.draft.counts, { photo: 2, attach: 0, art: 0, cover: 0 });
    const list = await staff.call('GET', '/api/drafts');
    assert.ok(list.body.drafts.some((d) => d.id === id && d.title === 'ร่างแรก' && d.thumb));
    const one = (await staff.call('GET', `/api/drafts/${id}`)).body.draft;
    assert.equal(one.data.chairPrefix, 'ผศ.ดร.');
    assert.equal(one.data.guests[0].prefix, 'นาย');
    assert.deepEqual(one.files.map((f) => f.name), ['a.jpg', 'b.jpg']);
    const thumb = await staff.call('GET', one.files[0].thumb);
    assert.equal(thumb.status, 200);
    // Not the PR team's, not another sender's, not readers'
    for (const who of [pr, student, anon]) {
      assert.ok([401, 404].includes((await who.call('GET', `/api/drafts/${id}`)).status));
      assert.ok([401, 404].includes((await who.call('GET', one.files[0].url)).status));
    }
    assert.ok(!(await pr.call('GET', '/api/pr/submissions')).body.items?.some?.((s) => s.title === 'ร่างแรก'));
  });

  test('saving again: removed files go, new ones come, in the order arranged on the page', async () => {
    const r = await staff.call('POST', '/api/drafts', form({ type: 'news', title: 'เรียงภาพ' }, { photo: [await jpg('1.jpg', '#111'), await jpg('2.jpg', '#222'), await jpg('3.jpg', '#333')] }));
    const id = r.body.draft.id;
    const files = (await staff.call('GET', `/api/drafts/${id}`)).body.draft.files;
    const [f1, f2, f3] = files.map((f) => f.id);
    // Remove 2, add 4, order: 4, 3, 1
    const u = await staff.call('PUT', `/api/drafts/${id}`, form({ type: 'news', title: 'เรียงภาพ', removeFiles: [f2], order: { photo: ['u:0', `f:${f3}`, `f:${f1}`] } }, { photo: [await jpg('4.jpg', '#444')] }));
    assert.equal(u.status, 200, JSON.stringify(u.body));
    const after = (await staff.call('GET', `/api/drafts/${id}`)).body.draft.files;
    assert.deepEqual(after.map((f) => f.name), ['4.jpg', '3.jpg', '1.jpg']);
    const gone = (await query('select path from draft_files where id = $1', [f2])).rows;
    assert.equal(gone.length, 0);
  });

  test('sending a draft: its files move to the submission in their order (first = cover), the draft is gone', async () => {
    const r = await staff.call('POST', '/api/drafts', form({ type: 'news', title: 'ส่งจากร่าง' }, { photo: [await jpg('x.jpg', '#a00'), await jpg('y.jpg', '#0a0')] }));
    const id = r.body.draft.id;
    const [fx, fy] = (await staff.call('GET', `/api/drafts/${id}`)).body.draft.files.map((f) => f.id);
    const draftPath = (await query('select path from draft_files where id = $1', [fx])).rows[0].path;
    // y first, then a new z, then x
    const s = await staff.call('POST', '/api/submissions', form({ ...NEWS, title: 'ส่งจากร่าง', draftId: id, order: { photo: [`f:${fy}`, 'u:0', `f:${fx}`] } }, { photo: [await jpg('z.jpg', '#00a')] }));
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const photos = s.body.submission.files.filter((f) => f.kind === 'photo');
    assert.deepEqual(photos.map((f) => f.name), ['y.jpg', 'z.jpg', 'x.jpg']);
    assert.equal(photos[0].cover, true);
    assert.equal((await staff.call('GET', `/api/drafts/${id}`)).status, 404, 'the draft is gone');
    assert.ok(!existsSync(abs(draftPath)), 'its file is no longer in drafts/');
    const moved = (await query('select path from submission_files where id = $1', [fx])).rows[0].path;
    assert.ok(moved.startsWith(`submissions/${s.body.submission.id}/`) && existsSync(abs(moved)));
    // PR opens the moved file
    assert.equal((await pr.call('GET', `/api/files/${fx}?v=web`)).status, 200);
    // Sending the same draft twice does not make a second submission
    assert.equal((await staff.call('POST', '/api/submissions', form({ ...NEWS, draftId: id }, { photo: [await jpg('w.jpg', '#999')] }))).status, 404);
  });

  test('a draft that is not complete cannot be sent; it stays a draft with its files', async () => {
    const r = await staff.call('POST', '/api/drafts', form({ type: 'news', title: 'ยังไม่ครบ' }, { photo: [await jpg('p.jpg', '#555')] }));
    const id = r.body.draft.id;
    const s = await staff.call('POST', '/api/submissions', form({ type: 'news', credit: 'งานประชาสัมพันธ์ทดสอบ', title: 'ยังไม่ครบ', draftId: id, audience: ['public'], consent: true }));
    assert.equal(s.status, 400);
    const d = (await staff.call('GET', `/api/drafts/${id}`)).body.draft;
    assert.equal(d.files.length, 1);
    assert.ok(existsSync(abs((await query('select path from draft_files where draft_id = $1', [id])).rows[0].path)));
  });

  test('delete; at most 20 drafts; university accounts only', async () => {
    const r = await staff.call('POST', '/api/drafts', form({ type: 'banner', title: 'ลบทิ้ง' }, { art: [await jpg('art.jpg', '#fa0')] }));
    const id = r.body.draft.id;
    const dir = abs(`drafts/${id}`);
    assert.ok(existsSync(dir));
    assert.equal((await staff.call('DELETE', `/api/drafts/${id}`)).status, 200);
    assert.ok(!existsSync(dir));
    assert.equal((await staff.call('GET', `/api/drafts/${id}`)).status, 404);
    // A photo on a banner draft is refused
    assert.equal((await staff.call('POST', '/api/drafts', form({ type: 'banner', title: 'ผิดชนิด' }, { photo: [await jpg('p.jpg', '#123')] }))).status, 400);
    const n = (await staff.call('GET', '/api/drafts')).body.drafts.length;
    for (let i = n; i < 20; i++) assert.equal((await staff.call('POST', '/api/drafts', form({ type: 'video', title: `ร่าง ${i}` }))).status, 201);
    assert.equal((await staff.call('POST', '/api/drafts', form({ type: 'video', title: 'เกิน' }))).status, 409);
    const external = await login('external');
    assert.equal((await external.call('POST', '/api/drafts', form({ type: 'video', title: 'ภายนอก' }))).status, 403);
  });
});

describe('submit form rules', () => {
  test('headline up to 180 characters, lead up to 250', async () => {
    const ok = await staff.call('POST', '/api/submissions', form({ ...NEWS, title: 'ห'.repeat(180), lead: 'ส'.repeat(250) }, { photo: [await jpg('h.jpg', '#246')] }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const long = await staff.call('POST', '/api/submissions', form({ ...NEWS, title: 'ห'.repeat(181) }, { photo: [await jpg('h.jpg', '#246')] }));
    assert.equal(long.status, 400);
    const lead = await staff.call('POST', '/api/submissions', form({ ...NEWS, lead: 'ส'.repeat(251) }, { photo: [await jpg('h.jpg', '#246')] }));
    assert.equal(lead.status, 400);
  });
  test('key people keep their name prefix; PR sees it', async () => {
    const s = await staff.call('POST', '/api/submissions', form({ ...NEWS, chairPrefix: 'รศ.ดร.', chairName: 'สมหมาย', chairPos: 'อธิการบดี', reporterPrefix: 'อาจารย์', reporterName: 'สมใจ', guests: [{ prefix: 'นาง', name: 'สมศรี', pos: 'ผู้ว่าราชการจังหวัด' }] },
      { photo: [await jpg('k.jpg', '#357')] }));
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const p = (await pr.call('GET', `/api/submissions/${s.body.submission.ref}`)).body.submission.fields.people;
    assert.deepEqual([p.chair.prefix, p.reporter.prefix, p.guests[0].prefix], ['รศ.ดร.', 'อาจารย์', 'นาง']);
  });
});
