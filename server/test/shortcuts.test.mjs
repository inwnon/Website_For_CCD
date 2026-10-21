// ทางลัดของฉัน (PR team, index.html), the kind counts of ข่าวล่าสุด, and ประเภทข่าว on banners.
// What the tests change is put back afterwards (cleanup.mjs).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { query } from '../db.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { ID_STAFF, anon, form, img, login } from './helpers.mjs';

let snap, pr, admin, staff;
before(async () => {
  snap = await snapshot();
  [pr, admin, staff] = await Promise.all(['pr', 'admin', 'staff'].map(login));
  await staff.call('PUT', '/api/me/profile', { ...ID_STAFF, unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'นักประชาสัมพันธ์', consent: true });
});
after(async () => {
  await query("update users set shortcuts = null where email in ('pr@sru.ac.th', 'admin@sru.ac.th')");
  await restore(snap);
});

describe('ทางลัดของฉัน', () => {
  test('the PR team has a default set; others have none', async () => {
    await query("update users set shortcuts = null where email = 'pr@sru.ac.th'");
    assert.deepEqual((await pr.call('GET', '/api/me')).body.shortcuts, ['review', 'add', 'news', 'digest']);
    assert.equal((await staff.call('GET', '/api/me')).body.shortcuts, undefined);
    assert.equal((await staff.call('PUT', '/api/me/shortcuts', { ids: ['news'] })).status, 403);
    assert.equal((await anon.call('PUT', '/api/me/shortcuts', { ids: ['news'] })).status, 401);
  });

  test('each person keeps their own, in their order; unknown ones and ตั้งค่าระบบ (admin only) are left out', async () => {
    const r = await pr.call('PUT', '/api/me/shortcuts', { ids: ['digest', 'review', 'nope', 'admin', 'review'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.shortcuts, ['digest', 'review']);
    assert.deepEqual((await pr.call('GET', '/api/me')).body.shortcuts, ['digest', 'review']);
    assert.deepEqual((await admin.call('PUT', '/api/me/shortcuts', { ids: ['admin', 'report'] })).body.shortcuts, ['admin', 'report']);
    assert.deepEqual((await pr.call('GET', '/api/me')).body.shortcuts, ['digest', 'review'], 'not changed by another person');
    assert.deepEqual((await pr.call('PUT', '/api/me/shortcuts', { ids: [] })).body.shortcuts, []);
    assert.equal((await pr.call('PUT', '/api/me/shortcuts', { ids: 'news' })).status, 400);
  });
});

describe('ข่าวล่าสุด: how many of each kind', () => {
  test('counted under the same time, whichever kind is shown', async () => {
    const all = (await anon.call('GET', '/api/news?feed=1&counts=1&limit=1')).body;
    assert.deepEqual(Object.keys(all.kinds).sort(), ['banner', 'news', 'video']);
    assert.equal(Object.values(all.kinds).reduce((a, n) => a + n, 0), all.total);
    const v = (await anon.call('GET', '/api/news?feed=1&counts=1&limit=1&kind=video')).body;
    assert.deepEqual(v.kinds, all.kinds);
    assert.equal(v.total, all.kinds.video);
    const month = (await anon.call('GET', '/api/news?feed=1&counts=1&limit=1&range=month')).body;
    assert.equal(Object.values(month.kinds).reduce((a, n) => a + n, 0), month.total);
    assert.equal((await anon.call('GET', '/api/news?limit=1')).body.kinds, undefined, 'only when asked');
  });
});

describe('ประเภทข่าว on banners', () => {
  test('needed when sent, imported and published', async () => {
    const base = { type: 'banner', title: 'แบนเนอร์ไม่มีประเภท', desc: 'ข้อความ', unit: 'กองกลาง', designer: 'ทีมกราฟิก', audience: ['public'], consent: true };
    const art = { art: [['art.jpg', await img('#a55', 800, 1000), 'image/jpeg']] };
    const no = await staff.call('POST', '/api/submissions', form(base, art));
    assert.equal(no.status, 400);
    assert.ok(no.body.details.categories);
    const ok = await staff.call('POST', '/api/submissions', form({ ...base, categories: ['ข่าวการศึกษา'] }, art));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const ref = ok.body.submission.ref;
    assert.deepEqual((await pr.call('GET', `/api/pr/submissions/${ref}`)).body.submission.fields.categories, ['ข่าวการศึกษา']);
    const files = (await pr.call('GET', `/api/pr/submissions/${ref}`)).body.submission.files;
    assert.equal((await pr.call('POST', `/api/pr/submissions/${ref}/publish`, { cover: files[0].id, categories: [] })).status, 400, 'PR cannot publish it without one');
    const pub = await pr.call('POST', `/api/pr/submissions/${ref}/publish`, { cover: files[0].id });
    assert.equal(pub.status, 201, JSON.stringify(pub.body));
    assert.deepEqual(pub.body.news.categories, ['ข่าวการศึกษา']);
    const imp = await pr.call('POST', '/api/pr/import', form({ kind: 'banner', title: 'นำเข้าแบนเนอร์ไม่มีประเภท', body: 'ข้อความ', credit: 'ทีมกราฟิก', unit: 'กองกลาง',
      categories: [], audience: ['public'], date: '2026-10-01' }, { photo: [['a.jpg', await img('#468', 800, 1000), 'image/jpeg']] }));
    assert.equal(imp.status, 400);
    assert.ok(imp.body.details.categories);
  });
});
