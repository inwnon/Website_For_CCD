// "ลบข่าว" on the PR desk (status rejected): hidden, not deleted. The sender no longer sees the work and is not told;
// PR finds it under "ลบแล้ว" and can bring it back, again without telling the sender. Also: the album link reaches PR,
// and news keeps ผู้ที่ได้รับมอบหมาย.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { query } from '../db.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { ID_STAFF, form, img, login } from './helpers.mjs';

const NEWS = {
  type: 'news', title: 'งานทดสอบการลบ', lead: 'สรุป', eventDate: '2026-10-10', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
  contentMode: 'own', body: 'ก'.repeat(160), audience: ['public'], consent: true, albumUrl: 'https://www.facebook.com/media/set/?set=a.456',
  reporterName: 'ผู้รายงาน', reporterPos: 'คณบดี', assigneePrefix: 'ผศ.ดร.', assigneeName: 'ผู้แทน ทดสอบ', assigneePos: 'รองอธิการบดีฝ่ายวิชาการ',
};
let snap, staff, pr, ref;
const mails = async (kind) => (await query('select * from email_outbox where ref = $1 and kind = $2', [ref, kind])).rows;

before(async () => {
  snap = await snapshot();
  [staff, pr] = await Promise.all([login('staff'), login('pr')]);
  await staff.call('PUT', '/api/me/profile', { ...ID_STAFF, unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'นักประชาสัมพันธ์', consent: true });
  const r = await staff.call('POST', '/api/submissions', form(NEWS, { photo: [['a.jpg', await img('#468', 800, 600), 'image/jpeg']] }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ref = r.body.submission.ref;
});
after(async () => { await restore(snap); });

describe('ลบข่าว', () => {
  test('PR sees the album link and the assignee', async () => {
    const f = (await pr.call('GET', `/api/submissions/${ref}`)).body.submission.fields;
    assert.equal(f.albumUrl, NEWS.albumUrl);
    assert.deepEqual(f.people.assignee, { prefix: 'ผศ.ดร.', name: 'ผู้แทน ทดสอบ', pos: 'รองอธิการบดีฝ่ายวิชาการ' });
  });
  test('no reason needed; gone for the sender, no email, no unread badge', async () => {
    const r = await pr.call('POST', `/api/pr/submissions/${ref}/status`, { status: 'rejected' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await staff.call('GET', `/api/submissions/${ref}`)).status, 404);
    assert.ok(!(await staff.call('GET', '/api/submissions')).body.submissions.some((s) => s.ref === ref));
    assert.equal((await mails('submission.status')).length, 0);
    assert.equal((await query('select sender_unread from submissions where ref = $1', [ref])).rows[0].sender_unread, false);
    assert.equal((await staff.call('POST', `/api/submissions/${ref}/messages`, { text: 'ยังอยู่ไหม' })).status, 404);
    const log = (await query("select summary from audit_log where target = $1 order by at desc limit 1", [ref])).rows[0];
    assert.equal(log.summary, `ลบงาน ${ref}`);
  });
  test('PR: not in "ทั้งหมด", listed under ลบแล้ว, cannot be published', async () => {
    const all = (await pr.call('GET', '/api/pr/submissions?limit=200')).body;
    assert.ok(!all.items.some((s) => s.ref === ref));
    const bin = (await pr.call('GET', '/api/pr/submissions?status=rejected&limit=200')).body;
    assert.ok(bin.items.some((s) => s.ref === ref));
    assert.equal((await pr.call('POST', `/api/pr/submissions/${ref}/publish`, { title: 'x' })).status, 409);
  });
  test('brought back to review quietly; the sender\'s timeline does not show the deletion', async () => {
    assert.equal((await pr.call('POST', `/api/pr/submissions/${ref}/status`, { status: 'review' })).status, 200);
    const s = (await staff.call('GET', `/api/submissions/${ref}`)).body.submission;
    assert.equal(s.status, 'review');
    assert.ok(!s.history.some((h) => h.status === 'rejected'));
    assert.equal(s.unread, false);
    assert.equal((await mails('submission.status')).length, 0);
  });
});
