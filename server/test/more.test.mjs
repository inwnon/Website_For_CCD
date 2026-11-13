// ลิงก์วิดีโอเพิ่มเติม (submit.html, pr-import.html → news.html), นักศึกษาฝึกงาน สสอ. (imports only), and the home page
// ข่าวล่าสุด: ประเภทเนื้อหา, ข่าวเด่น included and วิดีโอเสียงตามสาย left out (it has its own shelf).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { query } from '../db.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { ID_STAFF, anon, form, img, login } from './helpers.mjs';

let snap, staff, pr, admin, intern;
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const MORE = ['https://youtu.be/abcdefghijk', 'https://www.facebook.com/watch/?v=123456789'];
const VIDEO = { type: 'video', desc: 'คำอธิบายวิดีโอทดสอบ', title: 'วิดีโอทดสอบหลายลิงก์', eventDate: '2026-10-12', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
  videoLink: YT, videoPlatform: 'youtube', audience: ['public'], consent: true };
const IMPORT = { kind: 'video', channels: ['facebook'], body: 'ข้อความประกอบทดสอบ', title: 'นำเข้าวิดีโอทดสอบหลายลิงก์', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'], audience: ['public'],
  date: '2026-10-01', videoUrl: YT, confirmDuplicate: true };

before(async () => {
  snap = await snapshot();
  [staff, pr, admin, intern] = await Promise.all([login('staff'), login('pr'), login('admin'), login('intern')]);
  await staff.call('PUT', '/api/me/profile', { ...ID_STAFF, unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'นักประชาสัมพันธ์', consent: true });
});
after(async () => { await restore(snap); });

describe('ลิงก์วิดีโอเพิ่มเติม', () => {
  test('a video is sent with more links; each one must be a video link, five at most', async () => {
    const bad = await staff.call('POST', '/api/submissions', form({ ...VIDEO, videoLinks: [MORE[0], 'https://example.com/clip'] }));
    assert.equal(bad.status, 400);
    assert.match(bad.body.details.videoLinks, /ลิงก์เพิ่มเติมที่ 2/);
    const many = await staff.call('POST', '/api/submissions', form({ ...VIDEO, videoLinks: Array.from({ length: 6 }, (_, i) => `https://youtu.be/abcdefghij${i}`) }));
    assert.equal(many.status, 400);
    assert.match(many.body.details.videoLinks, /ไม่เกิน 5/);
    // Empty boxes and the main link again are left out
    const ok = await staff.call('POST', '/api/submissions', form({ ...VIDEO, videoLinks: [MORE[0], '', YT, MORE[1], MORE[0]] }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const ref = ok.body.submission.ref;
    assert.deepEqual((await pr.call('GET', `/api/pr/submissions/${ref}`)).body.submission.fields.videoLinks, MORE);

    // Published: the story has them, with the platform of each
    const p = await pr.call('POST', `/api/pr/submissions/${ref}/publish`, { categories: VIDEO.categories, audience: ['public'] });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const s = (await anon.call('GET', `/api/news/${p.body.news.id}`)).body.story;
    assert.deepEqual(s.videoLinks, [{ url: MORE[0], platform: 'youtube' }, { url: MORE[1], platform: 'facebook' }]);
  });

  test('imported and edited with more links (pr-import.html)', async () => {
    const noMain = await pr.call('POST', '/api/pr/import', form({ ...IMPORT, videoUrl: null, kind: 'news', credit: 'งานประชาสัมพันธ์ทดสอบ', body: 'ก'.repeat(40), videoLinks: [MORE[0]] }, { photo: [['a.jpg', await img('#468', 400, 300), 'image/jpeg']] }));
    assert.equal(noMain.status, 400);
    assert.match(noMain.body.details.videoUrl, /ลิงก์วิดีโอหลัก/);
    const i = await pr.call('POST', '/api/pr/import', form({ ...IMPORT, videoLinks: MORE }));
    assert.equal(i.status, 201, JSON.stringify(i.body));
    const id = i.body.news.id;
    assert.deepEqual((await pr.call('GET', `/api/pr/news/${id}`)).body.story.videoLinks, MORE);
    const e = await pr.call('PUT', `/api/pr/news/${id}`, form({ ...IMPORT, videoLinks: [MORE[1]], photos: [] }));
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.deepEqual((await anon.call('GET', `/api/news/${id}`)).body.story.videoLinks, [{ url: MORE[1], platform: 'facebook' }]);
  });
});

describe('นักศึกษาฝึกงาน สสอ.', () => {
  test('imports past stories, and has no other part of the PR desk', async () => {
    const me = (await intern.call('GET', '/api/me')).body.user;
    assert.equal(me.role, 'intern');
    assert.equal(me.baseRole, 'student', 'a student everywhere else (profile form, what they may read)');
    const i = await intern.call('POST', '/api/pr/import', form({ ...IMPORT, title: 'ข่าวที่นักศึกษาฝึกงานนำเข้า' }));
    assert.equal(i.status, 201, JSON.stringify(i.body));
    for (const [m, path] of [['GET', '/api/pr/news'], ['GET', `/api/pr/news/${i.body.news.id}`], ['POST', `/api/pr/news/${i.body.news.id}/feature`], ['GET', '/api/pr/submissions'], ['GET', '/api/reports']]) {
      assert.equal((await intern.call(m, path, m === 'POST' ? { featured: true } : undefined)).status, 403, `${m} ${path}`);
    }
    // Profile: the student form
    const bad = await intern.call('PUT', '/api/me/profile', { firstName: 'ฝึกงาน', lastName: 'ทดสอบ', phone: '0812345678', consent: true });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.details.unit && bad.body.details.year, 'asks for คณะ and ชั้นปี');
  });

  test('ผู้ดูแลระบบ gives and takes back the role (chanon.html)', async () => {
    const email = 'intern-test@student.sru.ac.th';
    assert.equal((await admin.call('PUT', '/api/admin/roles', { email, role: 'intern' })).status, 200);
    const u = (await admin.call('GET', `/api/admin/users?role=intern&q=${encodeURIComponent(email)}`)).body.items;
    assert.equal(u[0]?.role, 'intern');
    assert.equal((await admin.call('PUT', '/api/admin/roles', { email, role: 'default' })).status, 200);
  });
});

describe('ข่าวล่าสุด on the home page', () => {
  test('ประเภทเนื้อหา: only that kind', async () => {
    for (const kind of ['news', 'video', 'banner']) {
      const r = (await anon.call('GET', `/api/news?feed=1&kind=${kind}&limit=48`)).body;
      assert.ok(r.items.filter((n) => !n.locked).every((n) => n.kind === kind), kind);
    }
  });

  test('a featured story is in ข่าวล่าสุด too; วิดีโอเสียงตามสาย is not (it has its own shelf), but search and the full feed keep it', async () => {
    const make = async (fields, files) => {
      const i = await pr.call('POST', '/api/pr/import', form(fields, files));
      assert.equal(i.status, 201, JSON.stringify(i.body));
      await query('update news set published_at = now() - interval \'1 minute\' where id = $1', [i.body.news.id]); // among the newest
      return i.body.news.id;
    };
    const star = await make({ ...IMPORT, kind: 'news', credit: 'งานประชาสัมพันธ์ทดสอบ', videoUrl: null, title: 'ข่าวเด่นทดสอบรวมข่าว', body: 'ก'.repeat(40) },
      { photo: [['a.jpg', await img('#468', 400, 300), 'image/jpeg']] });
    await pr.call('POST', `/api/pr/news/${star}/feature`, { featured: true });
    const sound = await make({ ...IMPORT, title: 'เสียงตามสายทดสอบรวมข่าว', categories: ['วิดีโอเสียงตามสาย'] });
    const latest = (await anon.call('GET', '/api/news?feed=1&skipSound=1&counts=1&limit=12')).body;
    const ids = latest.items.map((n) => n.id);
    assert.ok(ids.includes(star), 'featured story in ข่าวล่าสุด');
    assert.ok(!ids.includes(sound), 'no เสียงตามสาย in ข่าวล่าสุด');
    const all = (await anon.call('GET', '/api/news?feed=1&counts=1&limit=12')).body;
    assert.ok(all.items.some((n) => n.id === sound), 'without skipSound the list is as before');
    assert.equal(latest.kinds.video, all.kinds.video - 1, 'the video badge counts only the cards shown');
    const shelf = (await anon.call('GET', `/api/news/search?${new URLSearchParams({ cat: 'วิดีโอเสียงตามสาย', sort: 'newest', limit: '4' })}`)).body.items;
    assert.ok(shelf.some((n) => n.id === sound), 'the เสียงตามสาย shelf still has it');
  });
});

describe('จัดการข่าว (pr-news.html)', () => {
  test('a page past the end still says how many stories there are, so the page can go to the last one', async () => {
    for (const show of ['all', 'live', 'imported', 'withdrawn']) {
      const r = (await pr.call('GET', `/api/pr/news?show=${show}&limit=20&offset=100000`)).body;
      assert.deepEqual(r.items, []);
      assert.equal(r.total, r.counts[show], show);
    }
    const r = (await pr.call('GET', '/api/pr/news?limit=100')).body;
    assert.equal(r.items.length, Math.min(100, r.counts.all), '100 a page');
  });
});
