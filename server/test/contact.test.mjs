// ติดต่อเรา (GET /api/contact): the central PR team, and faculty staff who ticked "ฉันเป็นประชาสัมพันธ์ของคณะ/หน่วยงาน"
// in their profile (users.unit_pr), each with the unit they belong to (most active senders first; the count is not shown).
// Work details and the profile photo (served by this server, only for people on the list). Video submissions keep ผู้ผลิต.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { query } from '../db.mjs';
import { abs } from '../files.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { ID_OTHER, ID_STAFF, anon, form, img, login } from './helpers.mjs';

const T = 'contact-test-';
const add = (email, f) => query(
  `insert into users (email, name, role, unit, position, first_name, last_name, phone, photo_path, avatar_url, consent_at, unit_pr)
   values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
  [T + email, `${f.first} ${f.last}`, f.role || 'staff', f.unit || null, f.position || null, f.first, f.last, f.phone || null,
    f.photo || null, 'https://lh3.googleusercontent.com/a/x', f.consent === false ? null : new Date(), !!f.unitPr]).then((r) => r.rows[0].id);

let snap, staff, student, pr, facPr, central, teacher;
before(async () => {
  snap = await snapshot();
  [staff, student, pr] = await Promise.all([login('staff'), login('student'), login('pr')]);
  // Submitting needs a complete profile; set it here so this file passes on a fresh database too
  await staff.call('PUT', '/api/me/profile', { ...ID_STAFF, unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'นักประชาสัมพันธ์', consent: true });
  await query('delete from pr_team where email like $1', [T + '%']);
  await query('delete from users where email like $1', [T + '%']);
  await mkdir(abs('avatars'), { recursive: true });
  await writeFile(abs('avatars/contact-test.webp'), await sharp({ create: { width: 64, height: 64, channels: 3, background: '#468' } }).webp().toBuffer());
  central = await add('central@sru.ac.th', { role: 'pr', first: 'ทีมกลาง', last: 'ทดสอบ', position: 'นักประชาสัมพันธ์', phone: '1101', photo: 'avatars/contact-test.webp' });
  facPr = await add('fac@sru.ac.th', { unit: 'คณะครุศาสตร์', position: 'นักประชาสัมพันธ์คณะ', unitPr: true, first: 'คณะครุ', last: 'ทดสอบ', phone: '2202' });
  await add('fac2@sru.ac.th', { unit: 'คณะนิติศาสตร์', position: 'เจ้าหน้าที่ PR', unitPr: true, first: 'คณะนิติ', last: 'ทดสอบ', phone: '2203' });
  teacher = await add('teacher@sru.ac.th', { unit: 'คณะครุศาสตร์', position: 'อาจารย์', first: 'อาจารย์', last: 'ทดสอบ', phone: '2204' });
  await add('school@sru.ac.th', { unit: 'โรงเรียนสาธิตแห่งมหาวิทยาลัยราชภัฏสุราษฎร์ธานี', position: 'นักประชาสัมพันธ์', unitPr: true, first: 'สาธิต', last: 'ทดสอบ', phone: '2206' });
  await add('center@sru.ac.th', { unit: 'ศูนย์วิทยาศาสตร์', position: 'เจ้าหน้าที่ประชาสัมพันธ์', unitPr: true, first: 'ศูนย์วิทย์', last: 'ทดสอบ', phone: '2207' });
  // ประชาสัมพันธ์หน่วยงาน of a sub-unit, whatever the profile position says: in the main unit's card
  await add('coord@sru.ac.th', { role: 'coordinator', unit: 'สำนักวิทยบริการและเทคโนโลยีสารสนเทศ', position: 'อาจารย์', first: 'ผู้ประสาน', last: 'ทดสอบ', phone: '2208' });
  await query("insert into pr_team (email, role, unit) values ($1, 'coordinator', 'ศูนย์ภาษา')", [T + 'coord@sru.ac.th']);
  await add('office@sru.ac.th', { unit: 'กองกลาง', position: 'นักประชาสัมพันธ์', unitPr: true, first: 'กองกลาง', last: 'ทดสอบ', phone: '2205' });
  await add('new@sru.ac.th', { unit: 'คณะครุศาสตร์', position: 'นักประชาสัมพันธ์', unitPr: true, first: 'ยังไม่ยินยอม', last: 'ทดสอบ', consent: false });
  // PR in the position but not ticked: no longer listed
  await add('pos@sru.ac.th', { unit: 'คณะครุศาสตร์', position: 'นักประชาสัมพันธ์', first: 'ไม่ได้ติ๊ก', last: 'ทดสอบ', phone: '2209' });
  for (const n of [1, 2]) {
    await query(`insert into submissions (ref, type, status, sender_id, unit, title, audience) values ($1, 'news', 'review', $2, 'คณะครุศาสตร์', 'ทดสอบ', '{public}')`, [`CT-TEST-${n}`, facPr]);
  }
});
after(async () => {
  await query("delete from submissions where ref like 'CT-TEST-%'");
  await query('delete from pr_team where email like $1', [T + '%']);
  await query('delete from users where email like $1', [T + '%']);
  await rm(abs('avatars/contact-test.webp'), { force: true });
  await restore(snap);
});

describe('contact page', () => {
  test('anyone may read it; central team, then faculty PR who ticked the box, with their unit', async () => {
    const r = await anon.call('GET', '/api/contact');
    assert.equal(r.status, 200);
    const c = r.body.team.find((p) => p.name === 'ทีมกลาง ทดสอบ');
    assert.deepEqual({ ...c, photo: undefined }, { name: 'ทีมกลาง ทดสอบ', position: 'นักประชาสัมพันธ์', ext: '1101', photo: undefined });
    assert.match(c.photo, new RegExp(`^/api/contact/photo/${central}\\.webp\\?v=[0-9a-f]{10}$`), 'the photo, through this server');
    const units = r.body.faculties.map((f) => f.unit);
    assert.ok(units.indexOf('คณะครุศาสตร์') < units.indexOf('คณะนิติศาสตร์'), 'faculties in org order');
    const people = r.body.faculties.flatMap((f) => f.people.map((p) => ({ ...p, card: f.unit })));
    const kru = people.find((p) => p.name === 'คณะครุ ทดสอบ');
    assert.deepEqual({ ...kru, photo: undefined }, { name: 'คณะครุ ทดสอบ', position: 'นักประชาสัมพันธ์คณะ', ext: '2202', photo: undefined, unit: 'คณะครุศาสตร์', card: 'คณะครุศาสตร์' }, 'no count of what they sent');
    assert.ok(people.some((p) => p.name === 'คณะนิติ ทดสอบ'), 'every unit PR who ticked the box');
    assert.equal(people.find((p) => p.name === 'สาธิต ทดสอบ')?.card, 'โรงเรียนสาธิตแห่งมหาวิทยาลัยราชภัฏสุราษฎร์ธานี', 'a unit in คณะ / วิทยาลัย that is not a faculty');
    assert.equal(people.find((p) => p.name === 'ศูนย์วิทย์ ทดสอบ')?.card, 'ศูนย์วิทยาศาสตร์', 'units outside the faculties too');
    assert.ok(units.indexOf('คณะนิติศาสตร์') < units.indexOf('ศูนย์วิทยาศาสตร์'), 'faculties first, then units');
    const coord = people.find((p) => p.name === 'ผู้ประสาน ทดสอบ');
    assert.equal(coord?.card, 'สำนักวิทยบริการและเทคโนโลยีสารสนเทศ', 'a coordinator of a sub-unit, in the main unit');
    assert.equal(coord.unit, 'ศูนย์ภาษา', 'with the sub-unit they belong to');
    for (const n of ['อาจารย์ ทดสอบ', 'กองกลาง ทดสอบ', 'ยังไม่ยินยอม ทดสอบ', 'ไม่ได้ติ๊ก ทดสอบ']) assert.ok(!people.some((p) => p.name === n), `${n} not listed`);
    assert.ok(!JSON.stringify(r.body).includes('@'), 'no email addresses');
    assert.ok(!JSON.stringify(r.body).includes('googleusercontent'), 'no link to Google');
    assert.ok(people.find((p) => p.name === 'คณะนิติ ทดสอบ').photo.startsWith('/api/contact/photo/'), 'a Google photo comes through this server too');
  });
  test('the profile box: staff tick it to be listed and untick it to leave; ignored for other roles', async () => {
    const listed = async () => (await anon.call('GET', '/api/contact')).body.faculties.some((f) => f.people.some((p) => p.name === 'สมชาย ใจดี'));
    const base = { ...ID_STAFF, unit: 'คณะครุศาสตร์', position: 'อาจารย์', consent: true };
    let r = await staff.call('PUT', '/api/me/profile', { ...base, unitPr: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.unitPr, true);
    assert.ok(await listed(), 'ticked: on the page whatever the position says');
    r = await staff.call('PUT', '/api/me/profile', { ...base, position: 'นักประชาสัมพันธ์', unitPr: false });
    assert.equal(r.body.user.unitPr, false);
    assert.ok(!(await listed()), 'unticked: off the page, also with PR in the position');
    r = await staff.call('PUT', '/api/me/profile', { ...base, unitPr: 'yes' });
    assert.equal(r.body.user.unitPr, false, 'only true ticks it');
    r = await student.call('PUT', '/api/me/profile', { ...ID_OTHER, unit: 'คณะครุศาสตร์', major: 'คณิตศาสตร์', year: 2, consent: true, unitPr: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.unitPr, false, 'students cannot tick it');
    await staff.call('PUT', '/api/me/profile', { ...ID_STAFF, unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'นักประชาสัมพันธ์', consent: true });
  });
  test('photos open for anyone, only for people on the list', async () => {
    const ok = await anon.call('GET', `/api/contact/photo/${central}.webp`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/webp');
    assert.equal((await anon.call('GET', `/api/contact/photo/${teacher}.webp`)).status, 404, 'not on the list');
    assert.equal((await anon.call('GET', '/api/contact/photo/nope.webp')).status, 404);
  });
});

describe('video producer', () => {
  test('ผู้ผลิต is kept on videos and shown to PR; at most 120 characters', async () => {
    const v = { type: 'video', desc: 'คำอธิบายวิดีโอทดสอบ', title: 'วิดีโอทดสอบ', eventDate: '2026-10-01', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
      videoPlatform: 'youtube', videoLink: 'https://youtu.be/dQw4w9WgXcQ', audience: ['public'], consent: true };
    const s = await staff.call('POST', '/api/submissions', form({ ...v, producer: 'ทีมวิดีโอ กองกลาง' }));
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal((await pr.call('GET', `/api/submissions/${s.body.submission.ref}`)).body.submission.fields.producer, 'ทีมวิดีโอ กองกลาง');
    assert.equal((await staff.call('POST', '/api/submissions', form({ ...v, producer: 'ก'.repeat(121) }))).status, 400);
    const b = await staff.call('POST', '/api/submissions', form({ type: 'banner', categories: ['ข่าวการศึกษา'], designer: 'ทีมกราฟิกทดสอบ', title: 'แบนเนอร์', desc: 'x', unit: 'กองกลาง', producer: 'ไม่ใช่วิดีโอ', audience: ['public'], consent: true },
      { art: [['a.png', Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png']] }));
    if (b.status === 201) assert.equal((await pr.call('GET', `/api/submissions/${b.body.submission.ref}`)).body.submission.fields.producer, null);
    const d = await staff.call('POST', '/api/drafts', form({ type: 'video', title: 'ร่างวิดีโอ', producer: 'สมศักดิ์' }));
    assert.equal((await staff.call('GET', `/api/drafts/${d.body.draft.id}`)).body.draft.data.producer, 'สมศักดิ์');
  });
  test('ภาพหน้าปก: one picture, videos only; it becomes the story cover', async () => {
    const v = { type: 'video', desc: 'คำอธิบายวิดีโอทดสอบ', title: 'วิดีโอมีปก', eventDate: '2026-10-01', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
      videoPlatform: 'facebook', videoLink: 'https://www.facebook.com/sru/videos/123', audience: ['public'], consent: true };
    const pic = async (c) => ['cover.jpg', await img(c, 1280, 720), 'image/jpeg'];
    const s = await staff.call('POST', '/api/submissions', form(v, { cover: [await pic('#a3c')] }));
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const sub = (await pr.call('GET', `/api/submissions/${s.body.submission.ref}`)).body.submission;
    const f = sub.files.find((x) => x.kind === 'cover');
    assert.ok(f?.thumb && f.cover, 'cover file with a web copy');
    assert.equal((await staff.call('POST', '/api/submissions', form(v, { cover: [await pic('#111'), await pic('#222')] }))).status, 400, 'one picture only');
    const news = await staff.call('POST', '/api/submissions', form({ type: 'news', credit: 'งานประชาสัมพันธ์ทดสอบ', title: 'ข่าว', eventDate: '2026-10-01', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
      contentMode: 'own', body: 'ก'.repeat(160), audience: ['public'], consent: true }, { photo: [await pic('#333')], cover: [await pic('#444')] }));
    assert.equal(news.status, 400, 'not for news');
    const pub = await pr.call('POST', `/api/pr/submissions/${s.body.submission.ref}/publish`, { title: 'วิดีโอมีปก', videoUrl: v.videoLink, categories: ['ข่าวการศึกษา'], audience: ['public'] });
    assert.equal(pub.status, 201, JSON.stringify(pub.body));
    const story = (await anon.call('GET', `/api/news/${pub.body.news.id}`)).body;
    assert.ok((story.story || story).cover || (story.story || story).photos?.length, 'published story has the cover');
    // Drafts keep it
    const d = await staff.call('POST', '/api/drafts', form({ type: 'video', title: 'ร่างมีปก' }, { cover: [await pic('#555')] }));
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.equal((await staff.call('GET', `/api/drafts/${d.body.draft.id}`)).body.draft.files.filter((x) => x.kind === 'cover').length, 1);
  });
  test('a YouTube video without a cover: its picture from this site on the story', async () => {
    const v = { type: 'video', desc: 'คำอธิบายวิดีโอทดสอบ', title: 'วิดีโอ YouTube ไม่มีปก', eventDate: '2026-10-01', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
      videoPlatform: 'youtube', videoLink: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', audience: ['public'], consent: true };
    const s = await staff.call('POST', '/api/submissions', form(v));
    const pub = await pr.call('POST', `/api/pr/submissions/${s.body.submission.ref}/publish`, { title: v.title, videoUrl: v.videoLink, categories: v.categories, audience: ['public'] });
    assert.equal(pub.status, 201, JSON.stringify(pub.body));
    const id = pub.body.news.id;
    const story = (await anon.call('GET', `/api/news/${id}`)).body;
    assert.equal((story.story || story).videoThumb, '/media/video/dQw4w9WgXcQ.webp');
  });
  test('card preview picture of a YouTube link: signed-in only', async () => {
    assert.equal((await anon.call('GET', '/api/video-thumb/dQw4w9WgXcQ.webp')).status, 401);
    assert.equal((await staff.call('GET', '/api/video-thumb/not*an*id')).status, 404);
  });
  test('ประเภทข่าว วิดีโอเสียงตามสาย: videos only; the pages get it', async () => {
    const v = { type: 'video', desc: 'คำอธิบายวิดีโอทดสอบ', title: 'วิดีโอเสียงตามสาย', eventDate: '2026-10-01', unit: 'กองกลาง', videoPlatform: 'youtube', videoLink: 'https://youtu.be/dQw4w9WgXcQ', audience: ['public'], consent: true };
    const ok = await staff.call('POST', '/api/submissions', form({ ...v, categories: ['วิดีโอเสียงตามสาย'] }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual((await pr.call('GET', `/api/submissions/${ok.body.submission.ref}`)).body.submission.fields.categories, ['วิดีโอเสียงตามสาย']);
    const news = await staff.call('POST', '/api/submissions', form({ type: 'news', credit: 'งานประชาสัมพันธ์ทดสอบ', title: 'ข่าว', eventDate: '2026-10-01', unit: 'กองกลาง', contentMode: 'own', body: 'ก'.repeat(160),
      categories: ['วิดีโอเสียงตามสาย'], audience: ['public'], consent: true }, { photo: [['a.jpg', await img('#468', 800, 600), 'image/jpeg']] }));
    assert.equal(news.status, 400);
    assert.match(news.body.details.categories, /ใช้กับวิดีโอเท่านั้น/);
    assert.match(await (await fetch('http://localhost:3000/site-config.js')).text(), /"videoCategories":\["วิดีโอเสียงตามสาย"\]/);
    assert.deepEqual((await pr.call('GET', '/api/pr/config')).body.videoCategories, ['วิดีโอเสียงตามสาย']);
  });
});
