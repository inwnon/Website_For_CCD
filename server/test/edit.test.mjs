// แก้ไขข่าว and the story text: PR's own version of work before publishing (pr_edit), editing a story on the site
// (PUT /api/pr/news/:id), ลบข่าว for withdrawn stories, font size / line spacing / bold, ส่งข่าวโดย and ตรวจทานโดย
// with the names of the accounts, and วิดีโอเสียงตามสาย as a story's one category.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { query } from '../db.mjs';
import { abs } from '../files.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { ID_STAFF, anon, form, img, login } from './helpers.mjs';

let snap, staff, pr, ref, newsId;
const BKK_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' });
const NEWS = { type: 'news', title: 'ข่าวทดสอบการแก้ไขโดยทีม PR', lead: 'คำโปรย', eventDate: '2026-10-12', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
  contentMode: 'own', body: `ย่อหน้าแรกมี **คำสำคัญ** อยู่กลางประโยค [size=18]**ตัวใหญ่และหนา**[/size] ต่อด้วย [size=16]ตัวเล็ก[/size] ${'ก'.repeat(150)}\n[lh=loose]ย่อหน้าที่สอง ระยะบรรทัดกว้าง`, bodySize: '16', bodyLeading: 'loose', audience: ['public'], consent: true };

before(async () => {
  snap = await snapshot();
  [staff, pr] = await Promise.all([login('staff'), login('pr')]);
  await staff.call('PUT', '/api/me/profile', { ...ID_STAFF, unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'นักประชาสัมพันธ์', consent: true });
  const photos = [['a.jpg', await img('#468', 800, 600), 'image/jpeg'], ['b.jpg', await img('#864', 800, 600), 'image/jpeg']];
  const s = await staff.call('POST', '/api/submissions', form(NEWS, { photo: photos }));
  assert.equal(s.status, 201, JSON.stringify(s.body));
  ref = s.body.submission.ref;
});
after(async () => { await restore(snap); });

describe('วิดีโอเสียงตามสาย is a story\'s one category', () => {
  test('not together with another one, on a video or on an import', async () => {
    const v = await staff.call('POST', '/api/submissions', form({ type: 'video', title: 'วิดีโอทดสอบ', eventDate: '2026-10-12', unit: 'กองกลาง',
      categories: ['วิดีโอเสียงตามสาย', 'ข่าวการศึกษา'], videoLink: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', videoPlatform: 'youtube', audience: ['public'], consent: true }));
    assert.equal(v.status, 400);
    assert.match(v.body.details.categories, /ประเภทเดียว/);
    const i = await pr.call('POST', '/api/pr/import', form({ kind: 'video', title: 'นำเข้าวิดีโอทดสอบ', unit: 'กองกลาง', categories: ['วิดีโอเสียงตามสาย', 'ข่าวการศึกษา'],
      audience: ['public'], date: '2026-10-01', videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }));
    assert.equal(i.status, 400);
    assert.match(i.body.details.categories, /ประเภทเดียว/);
  });
});

describe('แก้ไขข่าว before publishing (pr.html)', () => {
  test('the sender sends the text settings; PR keeps an edited version the sender does not see', async () => {
    const d = (await pr.call('GET', `/api/pr/submissions/${ref}`)).body;
    assert.equal(d.submission.fields.bodySize, 16);
    assert.equal(d.submission.fields.bodyLeading, 'loose');
    assert.equal(d.prEdit, null);
    const photo = d.submission.files.find((f) => f.kind === 'photo');
    const r = await pr.call('PUT', `/api/pr/submissions/${ref}/edit`, { title: 'หัวข้อที่ทีม PR แก้', body: 'เนื้อหาที่ทีม PR แก้แล้ว', bodySize: 18, bodyLeading: 'tight',
      categories: ['ข่าวการศึกษา'], audience: ['public'], cover: photo.id, gallery: ['not-a-file'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.prEdit.title, 'หัวข้อที่ทีม PR แก้');
    assert.equal(r.body.prEdit.cover, photo.id);
    assert.deepEqual(r.body.prEdit.gallery, [], 'only files of this work');
    assert.equal((await pr.call('PUT', `/api/pr/submissions/${ref}/edit`, { categories: ['วิดีโอเสียงตามสาย', 'ข่าวการศึกษา'] })).status, 400);
    const mine = (await staff.call('GET', `/api/submissions/${ref}`)).body;
    assert.ok(!JSON.stringify(mine).includes('หัวข้อที่ทีม PR แก้'), 'the sender does not see it');
    assert.equal((await staff.call('PUT', `/api/pr/submissions/${ref}/edit`, { title: 'x' })).status, 403, 'PR only');
  });
  test('publishing takes the text settings into the story and clears the edited version', async () => {
    const photos = (await pr.call('GET', `/api/submissions/${ref}`)).body.submission.files.filter((f) => f.kind === 'photo');
    const p = await pr.call('POST', `/api/pr/submissions/${ref}/publish`, { title: 'หัวข้อที่ทีม PR แก้', body: NEWS.body, bodySize: 18, bodyLeading: 'tight',
      categories: NEWS.categories, audience: ['public'], cover: photos[0].id, gallery: [photos[1].id] });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    newsId = p.body.news.id;
    assert.equal(p.body.prEdit, null);
    const row = (await query('select body_size, body_leading, reviewed_by from news where id = $1', [newsId])).rows[0];
    assert.deepEqual([row.body_size, row.body_leading], [18, 'tight']);
    assert.ok(row.reviewed_by);
  });
});

describe('the story page', () => {
  test('ส่งข่าวโดย the sender, ตรวจทานโดย who published it; bold and text settings in the page', async () => {
    const s = (await anon.call('GET', `/api/news/${newsId}`)).body.story;
    assert.equal(s.submittedBy, `${ID_STAFF.firstName} ${ID_STAFF.lastName}`);
    const reviewer = (await query(`select coalesce(nullif(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.name) n from news n join users u on u.id = n.reviewed_by where n.id = $1`, [newsId])).rows[0].n;
    assert.ok(reviewer);
    assert.equal(s.reviewedBy, reviewer);
    assert.deepEqual([s.bodySize, s.bodyLeading], [18, 'tight']);
    const html = String((await anon.call('GET', `/news.html?id=${newsId}`)).body);
    assert.match(html, /data-size="18" data-leading="tight"/);
    assert.match(html, /<p>ย่อหน้าแรกมี <strong>คำสำคัญ<\/strong> อยู่กลางประโยค/);
    assert.match(html, /<span data-size="18"><strong>ตัวใหญ่และหนา<\/strong><\/span> ต่อด้วย <span data-size="16">ตัวเล็ก<\/span>/, 'sizes on chosen words');
    assert.match(html, /<p data-leading="loose">ย่อหน้าที่สอง ระยะบรรทัดกว้าง<\/p>/, 'line spacing on that paragraph');
    assert.ok(!/<meta name="description" content="[^"]*(\*\*|\[size|\[lh)/.test(html), 'no marks in the description');
    const found = (await anon.call('GET', `/api/news/search?q=${encodeURIComponent('ตัวใหญ่และหนา')}`)).body.items.find((n) => n.id === newsId);
    assert.ok(found && !/\*\*|\[size/.test(found.snippet), 'no marks in search results');
  });
});

describe('แก้ไขข่าว on the site (pr-import.html?edit=id)', () => {
  test('text, settings and pictures; pictures no longer used are removed', async () => {
    const { story } = (await pr.call('GET', `/api/pr/news/${newsId}`)).body;
    assert.equal(story.photos.length, 2);
    const at = new Date(story.publishedAt);
    const data = { kind: 'news', title: 'หัวข้อหลังแก้ไขบนเว็บไซต์', lead: 'โปรยใหม่', body: 'เนื้อหาใหม่หลังแก้ไข ยาวพอสำหรับข่าว', unit: story.unit,
      categories: story.categories, audience: ['public'], date: BKK_DAY.format(at), time: '10:15', credit: 'ช่างภาพทดสอบ', bodySize: 17, bodyLeading: 'normal',
      photos: [`p:${story.photos[1].path}`, 'u:0'] };
    const r = await pr.call('PUT', `/api/pr/news/${newsId}`, form(data, { photo: [['c.jpg', await img('#2a6', 800, 600), 'image/jpeg']] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = (await pr.call('GET', `/api/pr/news/${newsId}`)).body.story;
    assert.equal(after.title, 'หัวข้อหลังแก้ไขบนเว็บไซต์');
    assert.equal(after.credit, 'ช่างภาพทดสอบ');
    assert.equal(after.bodySize, 17);
    assert.equal(after.photos[0].path, story.photos[1].path, 'the second picture is now the cover');
    assert.equal(after.photos.length, 2);
    assert.ok(!existsSync(abs(`media/${story.photos[0].path}`)), 'the picture taken out is gone');
    assert.ok(existsSync(abs(`media/${after.photos[1].path}`)));
    const rev = (await pr.call('GET', `/api/pr/news/${newsId}/revisions`)).body.items[0];
    assert.ok(rev.changes.some((c) => c.field === 'body_size'), 'the history has the text settings');
    assert.equal((await staff.call('PUT', `/api/pr/news/${newsId}`, form(data))).status, 403);
  });
});

describe('ลบข่าว (withdrawn stories)', () => {
  test('only a withdrawn story; gone for good, its work moves to ลบแล้ว', async () => {
    assert.equal((await pr.call('DELETE', `/api/pr/news/${newsId}`)).status, 409, 'withdraw first');
    assert.equal((await pr.call('POST', `/api/pr/news/${newsId}/withdraw`, { reason: 'ทดสอบลบข่าว' })).status, 200);
    assert.equal((await staff.call('DELETE', `/api/pr/news/${newsId}`)).status, 403);
    const r = await pr.call('DELETE', `/api/pr/news/${newsId}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await anon.call('GET', `/api/news/${newsId}`)).status, 404);
    assert.ok(!existsSync(abs(`media/${newsId}`)));
    assert.equal((await pr.call('GET', `/api/pr/submissions/${ref}`)).body.submission.status, 'rejected');
    assert.equal((await staff.call('GET', `/api/submissions/${ref}`)).status, 404, 'gone for the sender, as ลบข่าว');
  });
});
