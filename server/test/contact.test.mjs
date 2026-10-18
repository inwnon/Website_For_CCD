// ติดต่อเรา (GET /api/contact): the central PR team, and faculty staff whose position says PR with how many pieces they sent.
// Work details and the profile photo (served by this server, only for people on the list). Video submissions keep ผู้ผลิต.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { query } from '../db.mjs';
import { abs } from '../files.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { anon, form, img, login } from './helpers.mjs';

const T = 'contact-test-';
const add = (email, f) => query(
  `insert into users (email, name, role, unit, position, first_name, last_name, phone, photo_path, avatar_url, consent_at)
   values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
  [T + email, `${f.first} ${f.last}`, f.role || 'staff', f.unit || null, f.position || null, f.first, f.last, f.phone || null,
    f.photo || null, 'https://lh3.googleusercontent.com/a/x', f.consent === false ? null : new Date()]).then((r) => r.rows[0].id);

let snap, staff, pr, facPr, central, teacher;
before(async () => {
  snap = await snapshot();
  [staff, pr] = await Promise.all([login('staff'), login('pr')]);
  await query('delete from users where email like $1', [T + '%']);
  await mkdir(abs('avatars'), { recursive: true });
  await writeFile(abs('avatars/contact-test.webp'), await sharp({ create: { width: 64, height: 64, channels: 3, background: '#468' } }).webp().toBuffer());
  central = await add('central@sru.ac.th', { role: 'pr', first: 'ทีมกลาง', last: 'ทดสอบ', position: 'นักประชาสัมพันธ์', phone: '1101', photo: 'avatars/contact-test.webp' });
  facPr = await add('fac@sru.ac.th', { unit: 'คณะครุศาสตร์', position: 'นักประชาสัมพันธ์คณะ', first: 'คณะครุ', last: 'ทดสอบ', phone: '2202' });
  await add('fac2@sru.ac.th', { unit: 'คณะนิติศาสตร์', position: 'เจ้าหน้าที่ PR', first: 'คณะนิติ', last: 'ทดสอบ', phone: '2203' });
  teacher = await add('teacher@sru.ac.th', { unit: 'คณะครุศาสตร์', position: 'อาจารย์', first: 'อาจารย์', last: 'ทดสอบ', phone: '2204' });
  await add('office@sru.ac.th', { unit: 'กองกลาง', position: 'นักประชาสัมพันธ์', first: 'กองกลาง', last: 'ทดสอบ', phone: '2205' });
  await add('new@sru.ac.th', { unit: 'คณะครุศาสตร์', position: 'นักประชาสัมพันธ์', first: 'ยังไม่ยินยอม', last: 'ทดสอบ', consent: false });
  for (const n of [1, 2]) {
    await query(`insert into submissions (ref, type, status, sender_id, unit, title, audience) values ($1, 'news', 'review', $2, 'คณะครุศาสตร์', 'ทดสอบ', '{public}')`, [`CT-TEST-${n}`, facPr]);
  }
});
after(async () => {
  await query("delete from submissions where ref like 'CT-TEST-%'");
  await query('delete from users where email like $1', [T + '%']);
  await rm(abs('avatars/contact-test.webp'), { force: true });
  await restore(snap);
});

describe('contact page', () => {
  test('anyone may read it; central team, then faculty PR by position, with what they sent', async () => {
    const r = await anon.call('GET', '/api/contact');
    assert.equal(r.status, 200);
    const c = r.body.team.find((p) => p.name === 'ทีมกลาง ทดสอบ');
    assert.deepEqual({ ...c, photo: undefined }, { name: 'ทีมกลาง ทดสอบ', position: 'นักประชาสัมพันธ์', ext: '1101', photo: undefined });
    assert.match(c.photo, new RegExp(`^/api/contact/photo/${central}\\.webp\\?v=[0-9a-f]{10}$`), 'the photo, through this server');
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
    assert.ok(!JSON.stringify(r.body).includes('googleusercontent'), 'no link to Google');
    assert.ok(people.find((p) => p.name === 'คณะนิติ ทดสอบ').photo.startsWith('/api/contact/photo/'), 'a Google photo comes through this server too');
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
  test('ภาพหน้าปก: one picture, videos only; it becomes the story cover', async () => {
    const v = { type: 'video', title: 'วิดีโอมีปก', eventDate: '2026-10-01', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
      videoPlatform: 'facebook', videoLink: 'https://www.facebook.com/sru/videos/123', audience: ['public'], consent: true };
    const pic = async (c) => ['cover.jpg', await img(c, 1280, 720), 'image/jpeg'];
    const s = await staff.call('POST', '/api/submissions', form(v, { cover: [await pic('#a3c')] }));
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const sub = (await pr.call('GET', `/api/submissions/${s.body.submission.ref}`)).body.submission;
    const f = sub.files.find((x) => x.kind === 'cover');
    assert.ok(f?.thumb && f.cover, 'cover file with a web copy');
    assert.equal((await staff.call('POST', '/api/submissions', form(v, { cover: [await pic('#111'), await pic('#222')] }))).status, 400, 'one picture only');
    const news = await staff.call('POST', '/api/submissions', form({ type: 'news', title: 'ข่าว', eventDate: '2026-10-01', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
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
  test('a YouTube video without a cover: its picture from this site on the story and in the digest', async () => {
    const v = { type: 'video', title: 'วิดีโอ YouTube ไม่มีปก', eventDate: '2026-10-01', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
      videoPlatform: 'youtube', videoLink: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', audience: ['public'], consent: true };
    const s = await staff.call('POST', '/api/submissions', form(v));
    const pub = await pr.call('POST', `/api/pr/submissions/${s.body.submission.ref}/publish`, { title: v.title, videoUrl: v.videoLink, categories: v.categories, audience: ['public'] });
    assert.equal(pub.status, 201, JSON.stringify(pub.body));
    const id = pub.body.news.id;
    const story = (await anon.call('GET', `/api/news/${id}`)).body;
    assert.equal((story.story || story).videoThumb, '/media/video/dQw4w9WgXcQ.webp');
    const { pool } = await import('../digests.mjs');
    const at = (await query("select (published_at at time zone 'Asia/Bangkok')::date d from news where id = $1", [id])).rows[0].d;
    assert.equal((await pool({ range_start: at, range_end: at })).find((x) => x.id === id).img, '/media/video/dQw4w9WgXcQ.webp');
  });
  test('card preview picture of a YouTube link: signed-in only', async () => {
    assert.equal((await anon.call('GET', '/api/video-thumb/dQw4w9WgXcQ.webp')).status, 401);
    assert.equal((await staff.call('GET', '/api/video-thumb/not*an*id')).status, 404);
  });
  test('ประเภทข่าว วิดีโอเสียงตามสาย: videos only; the pages get it', async () => {
    const v = { type: 'video', title: 'วิดีโอเสียงตามสาย', eventDate: '2026-10-01', unit: 'กองกลาง', videoPlatform: 'youtube', videoLink: 'https://youtu.be/dQw4w9WgXcQ', audience: ['public'], consent: true };
    const ok = await staff.call('POST', '/api/submissions', form({ ...v, categories: ['วิดีโอเสียงตามสาย'] }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual((await pr.call('GET', `/api/submissions/${ok.body.submission.ref}`)).body.submission.fields.categories, ['วิดีโอเสียงตามสาย']);
    const news = await staff.call('POST', '/api/submissions', form({ type: 'news', title: 'ข่าว', eventDate: '2026-10-01', unit: 'กองกลาง', contentMode: 'own', body: 'ก'.repeat(160),
      categories: ['วิดีโอเสียงตามสาย'], audience: ['public'], consent: true }, { photo: [['a.jpg', await img('#468', 800, 600), 'image/jpeg']] }));
    assert.equal(news.status, 400);
    assert.match(news.body.details.categories, /ใช้กับวิดีโอเท่านั้น/);
    assert.match(await (await fetch('http://localhost:3000/site-config.js')).text(), /"videoCategories":\["วิดีโอเสียงตามสาย"\]/);
    assert.deepEqual((await pr.call('GET', '/api/pr/config')).body.videoCategories, ['วิดีโอเสียงตามสาย']);
  });
});
