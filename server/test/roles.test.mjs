// Developer accounts (DEVELOPERS in auth.mjs): highest rights, switch between ทีม PR งานสื่อสารองค์กร and ผู้พัฒนาระบบ
// per session; nobody else can switch, and chanon.html cannot change their role. Banner submissions keep ผู้ออกแบบ.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { query } from '../db.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { ID_STAFF, form, img, login } from './helpers.mjs';

let snap, dev, admin, pr, staff;
before(async () => {
  snap = await snapshot();
  [dev, admin, pr, staff] = await Promise.all([login('developer'), login('admin'), login('pr'), login('staff')]);
  // Submitting needs a complete profile; set it here so this file passes on a fresh database too
  await staff.call('PUT', '/api/me/profile', { ...ID_STAFF, unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'นักประชาสัมพันธ์', consent: true });
});
after(async () => { await restore(snap); });

describe('developer role switch', () => {
  test('a developer starts as ผู้พัฒนาระบบ with the highest rights', async () => {
    const me = (await dev.call('GET', '/api/me')).body.user;
    assert.equal(me.role, 'admin');
    assert.equal(me.developer, true);
    assert.equal((await dev.call('GET', '/api/admin/users')).status, 200);
    assert.equal((await dev.call('GET', '/api/admin/backups')).status, 200);
  });
  test('switched to the PR team: PR pages yes, settings no; and back', async () => {
    const r = await dev.call('POST', '/api/me/role', { role: 'pr' });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.role, 'pr');
    assert.equal((await dev.call('GET', '/api/me')).body.user.role, 'pr');
    assert.equal((await dev.call('GET', '/api/pr/submissions')).status, 200);
    assert.equal((await dev.call('GET', '/api/admin/users')).status, 403, 'not the settings while working as PR');
    const back = await dev.call('POST', '/api/me/role', { role: 'admin' });
    assert.equal(back.body.user.role, 'admin');
    assert.equal((await dev.call('GET', '/api/admin/users')).status, 200);
    const log = (await query("select summary from audit_log where action = 'role.switch' and actor_email = 'satearnpong.nis@sru.ac.th' order by at desc limit 2")).rows.map((x) => x.summary);
    assert.deepEqual(log, ['สลับบทบาทจาก ทีม PR งานสื่อสารองค์กร เป็น ผู้พัฒนาระบบ', 'สลับบทบาทจาก ผู้พัฒนาระบบ เป็น ทีม PR งานสื่อสารองค์กร']);
  });
  test('the switch belongs to the session: a new sign-in starts as ผู้พัฒนาระบบ again', async () => {
    await dev.call('POST', '/api/me/role', { role: 'pr' });
    const fresh = await login('developer');
    assert.equal((await fresh.call('GET', '/api/me')).body.user.role, 'admin');
    assert.equal((await dev.call('GET', '/api/me')).body.user.role, 'pr');
    await dev.call('POST', '/api/me/role', { role: 'admin' });
  });
  test('nobody else can switch; a role that is not one of the two is refused', async () => {
    for (const who of [admin, pr, staff]) assert.equal((await who.call('POST', '/api/me/role', { role: 'admin' })).status, 403);
    assert.equal((await dev.call('POST', '/api/me/role', { role: 'staff' })).status, 400);
    assert.equal((await dev.call('POST', '/api/me/role', { role: 'coordinator' })).status, 400);
  });
  test('chanon.html cannot change a developer\'s role; the list marks the account', async () => {
    const r = await admin.call('PUT', '/api/admin/roles', { email: 'satearnpong.nis@sru.ac.th', role: 'default' });
    assert.equal(r.status, 409);
    const list = (await admin.call('GET', '/api/admin/users?q=satearnpong.nis')).body.items;
    assert.ok(list.some((u) => u.email === 'satearnpong.nis@sru.ac.th' && u.developer));
    assert.equal((await dev.call('GET', '/api/me')).body.user.role, 'admin');
  });
});

describe('banner designer', () => {
  test('ผู้ออกแบบ or ที่มา must be filled; ที่มา goes on to the story; a video needs its description', async () => {
    const base = { type: 'banner', categories: ['ข่าวการศึกษา'], title: 'แบนเนอร์จากที่อื่น', desc: 'ข้อความ', unit: 'กองกลาง', audience: ['public'], consent: true };
    const art = { art: [['art.jpg', await img('#a55'), 'image/jpeg']] };
    const none = await staff.call('POST', '/api/submissions', form({ ...base, creditKind: 'source' }, art));
    assert.equal(none.status, 400);
    assert.equal(none.body.details.designer, 'กรอกที่มาของงาน');
    const s = await staff.call('POST', '/api/submissions', form({ ...base, designer: 'กระทรวง อว.', creditKind: 'source' }, art));
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const ref = s.body.submission.ref;
    assert.equal((await pr.call('GET', `/api/submissions/${ref}`)).body.submission.fields.creditKind, 'source');
    const files = (await pr.call('GET', `/api/pr/submissions/${ref}`)).body.submission.files;
    const pub = await pr.call('POST', `/api/pr/submissions/${ref}/publish`, { cover: files[0].id, audience: ['public'] });
    assert.equal(pub.status, 201, JSON.stringify(pub.body));
    const story = (await pr.call('GET', `/api/news/${pub.body.news.id}`)).body.story;
    assert.equal(story.creditKind, 'source');
    const video = await staff.call('POST', '/api/submissions', form({ type: 'video', title: 'วิดีโอไม่มีคำอธิบาย', eventDate: '2026-10-01', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
      videoPlatform: 'youtube', videoLink: 'https://youtu.be/dQw4w9WgXcQ', audience: ['public'], consent: true }));
    assert.equal(video.body.details.desc, 'กรอกคำอธิบายวิดีโอ');
  });

  test('ผู้ออกแบบ is kept on banners and shown to PR; other types ignore it', async () => {
    await staff.call('PUT', '/api/me/profile', { ...ID_STAFF, unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'นักประชาสัมพันธ์', consent: true });
    const art = [['art.jpg', await img('#fa0', 800, 600), 'image/jpeg']];
    const s = await staff.call('POST', '/api/submissions', form({ type: 'banner', categories: ['ข่าวการศึกษา'], title: 'แบนเนอร์ทดสอบ', desc: 'ข้อความ', unit: 'กองกลาง', designer: 'ทีมกราฟิก กองกลาง', audience: ['public'], consent: true }, { art }));
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal((await pr.call('GET', `/api/submissions/${s.body.submission.ref}`)).body.submission.fields.designer, 'ทีมกราฟิก กองกลาง');
    const long = await staff.call('POST', '/api/submissions', form({ type: 'banner', categories: ['ข่าวการศึกษา'], title: 'ยาว', desc: 'ข้อความ', unit: 'กองกลาง', designer: 'ก'.repeat(121), audience: ['public'], consent: true }, { art }));
    assert.equal(long.status, 400);
    // A draft keeps it too
    const d = await staff.call('POST', '/api/drafts', form({ type: 'banner', title: 'ร่างแบนเนอร์', designer: 'สมศรี' }));
    assert.equal((await staff.call('GET', `/api/drafts/${d.body.draft.id}`)).body.draft.data.designer, 'สมศรี');
  });
});
