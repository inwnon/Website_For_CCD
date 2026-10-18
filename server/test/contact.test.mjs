// ติดต่อเรา (GET /api/contact): the central PR team, and faculty staff whose position says PR with how many pieces they sent.
// Work details only; a profile photo only for signed-in readers, never the Google one. Video submissions keep ผู้ผลิต.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { query } from '../db.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { anon, form, img, login } from './helpers.mjs';

const T = 'contact-test-';
const add = (email, f) => query(
  `insert into users (email, name, role, unit, position, first_name, last_name, phone, photo_path, avatar_url, consent_at)
   values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
  [T + email, `${f.first} ${f.last}`, f.role || 'staff', f.unit || null, f.position || null, f.first, f.last, f.phone || null,
    f.photo || null, 'https://lh3.googleusercontent.com/a/x', f.consent === false ? null : new Date()]).then((r) => r.rows[0].id);

let snap, staff, pr, facPr;
before(async () => {
  snap = await snapshot();
  [staff, pr] = await Promise.all([login('staff'), login('pr')]);
  await query('delete from users where email like $1', [T + '%']);
  await add('central@sru.ac.th', { role: 'pr', first: 'ทีมกลาง', last: 'ทดสอบ', position: 'นักประชาสัมพันธ์', phone: '1101', photo: 'avatars/test.webp' });
  facPr = await add('fac@sru.ac.th', { unit: 'คณะครุศาสตร์', position: 'นักประชาสัมพันธ์คณะ', first: 'คณะครุ', last: 'ทดสอบ', phone: '2202' });
  await add('fac2@sru.ac.th', { unit: 'คณะนิติศาสตร์', position: 'เจ้าหน้าที่ PR', first: 'คณะนิติ', last: 'ทดสอบ', phone: '2203' });
  await add('teacher@sru.ac.th', { unit: 'คณะครุศาสตร์', position: 'อาจารย์', first: 'อาจารย์', last: 'ทดสอบ', phone: '2204' });
  await add('office@sru.ac.th', { unit: 'กองกลาง', position: 'นักประชาสัมพันธ์', first: 'กองกลาง', last: 'ทดสอบ', phone: '2205' });
  await add('new@sru.ac.th', { unit: 'คณะครุศาสตร์', position: 'นักประชาสัมพันธ์', first: 'ยังไม่ยินยอม', last: 'ทดสอบ', consent: false });
  for (const n of [1, 2]) {
    await query(`insert into submissions (ref, type, status, sender_id, unit, title, audience) values ($1, 'news', 'review', $2, 'คณะครุศาสตร์', 'ทดสอบ', '{public}')`, [`CT-TEST-${n}`, facPr]);
  }
});
after(async () => {
  await query("delete from submissions where ref like 'CT-TEST-%'");
  await query('delete from users where email like $1', [T + '%']);
  await restore(snap);
});

describe('contact page', () => {
  test('anyone may read it; central team, then faculty PR by position, with what they sent', async () => {
    const r = await anon.call('GET', '/api/contact');
    assert.equal(r.status, 200);
    const central = r.body.team.find((p) => p.name === 'ทีมกลาง ทดสอบ');
    assert.deepEqual(central, { name: 'ทีมกลาง ทดสอบ', position: 'นักประชาสัมพันธ์', ext: '1101', photo: null }, 'no photo signed out, no Google photo');
    const units = r.body.faculties.map((f) => f.unit);
    assert.ok(units.indexOf('คณะครุศาสตร์') < units.indexOf('คณะนิติศาสตร์'), 'faculties in org order');
    const people = r.body.faculties.flatMap((f) => f.people.map((p) => ({ ...p, unit: f.unit })));
    const kru = people.find((p) => p.name === 'คณะครุ ทดสอบ');
    assert.equal(kru.unit, 'คณะครุศาสตร์');
    assert.equal(kru.sent, 2);
    assert.equal(kru.ext, '2202');
    assert.ok(people.some((p) => p.name === 'คณะนิติ ทดสอบ' && p.sent === 0), '"PR" in the position counts too');
    for (const n of ['อาจารย์ ทดสอบ', 'กองกลาง ทดสอบ', 'ยังไม่ยินยอม ทดสอบ']) assert.ok(!people.some((p) => p.name === n), `${n} not listed`);
    assert.ok(!JSON.stringify(r.body).includes('@'), 'no email addresses');
    assert.ok(!JSON.stringify(r.body).includes('googleusercontent'), 'no Google photos');
  });
  test('signed-in readers see the uploaded profile photo', async () => {
    const central = (await staff.call('GET', '/api/contact')).body.team.find((p) => p.name === 'ทีมกลาง ทดสอบ');
    assert.equal(central.photo, '/api/avatars/test.webp');
  });
});

describe('video producer', () => {
  test('ผู้ผลิต is kept on videos and shown to PR; at most 120 characters', async () => {
    const v = { type: 'video', title: 'วิดีโอทดสอบ', eventDate: '2026-10-01', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
      videoPlatform: 'youtube', videoLink: 'https://youtu.be/dQw4w9WgXcQ', audience: ['public'], consent: true };
    const s = await staff.call('POST', '/api/submissions', form({ ...v, producer: 'ทีมวิดีโอ กองกลาง' }));
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal((await pr.call('GET', `/api/submissions/${s.body.submission.ref}`)).body.submission.fields.producer, 'ทีมวิดีโอ กองกลาง');
    assert.equal((await staff.call('POST', '/api/submissions', form({ ...v, producer: 'ก'.repeat(121) }))).status, 400);
    const b = await staff.call('POST', '/api/submissions', form({ type: 'banner', title: 'แบนเนอร์', desc: 'x', unit: 'กองกลาง', producer: 'ไม่ใช่วิดีโอ', audience: ['public'], consent: true },
      { art: [['a.png', Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png']] }));
    if (b.status === 201) assert.equal((await pr.call('GET', `/api/submissions/${b.body.submission.ref}`)).body.submission.fields.producer, null);
    const d = await staff.call('POST', '/api/drafts', form({ type: 'video', title: 'ร่างวิดีโอ', producer: 'สมศักดิ์' }));
    assert.equal((await staff.call('GET', `/api/drafts/${d.body.draft.id}`)).body.draft.data.producer, 'สมศักดิ์');
  });
  test('ประเภทข่าว วิดีโอเสียงตามสาย: videos only; the pages get it', async () => {
    const v = { type: 'video', title: 'วิดีโอเสียงตามสาย', eventDate: '2026-10-01', unit: 'กองกลาง', videoPlatform: 'youtube', videoLink: 'https://youtu.be/dQw4w9WgXcQ', audience: ['public'], consent: true };
    const ok = await staff.call('POST', '/api/submissions', form({ ...v, categories: ['วิดีโอเสียงตามสาย', 'ข่าวการศึกษา'] }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual((await pr.call('GET', `/api/submissions/${ok.body.submission.ref}`)).body.submission.fields.categories, ['วิดีโอเสียงตามสาย', 'ข่าวการศึกษา']);
    const news = await staff.call('POST', '/api/submissions', form({ type: 'news', title: 'ข่าว', eventDate: '2026-10-01', unit: 'กองกลาง', contentMode: 'own', body: 'ก'.repeat(160),
      categories: ['วิดีโอเสียงตามสาย'], audience: ['public'], consent: true }, { photo: [['a.jpg', await img('#468', 800, 600), 'image/jpeg']] }));
    assert.equal(news.status, 400);
    assert.match(news.body.details.categories, /ใช้กับวิดีโอเท่านั้น/);
    assert.match(await (await fetch('http://localhost:3000/site-config.js')).text(), /"videoCategories":\["วิดีโอเสียงตามสาย"\]/);
    assert.deepEqual((await pr.call('GET', '/api/pr/config')).body.videoCategories, ['วิดีโอเสียงตามสาย']);
  });
});
