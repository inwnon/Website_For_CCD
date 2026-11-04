// API tests against a running dev server (npm run dev, ALLOW_DEV_LOGIN=1).
// What the tests create is removed again afterwards (cleanup.mjs), also when tests fail.
// Run: npm test
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { restore, snapshot } from './cleanup.mjs';
import { BASE, ID_OTHER, ID_STAFF, form, img, login } from './helpers.mjs';

const NEWS = {
  type: 'news', credit: 'งานประชาสัมพันธ์ทดสอบ', title: 'ค่ายนักวิทยาศาสตร์น้อย ประจำปี 2569', lead: 'สรุปข่าวสั้น ๆ', eventDate: '2026-10-10', place: 'หอประชุม',
  unit: 'กองกลาง', categories: ['ข่าวการศึกษา'], contentMode: 'own', body: 'ก'.repeat(160),
  chairName: 'ผศ.ดร.ตัวอย่าง', chairPos: 'อธิการบดี', guests: [{ name: 'แขก', pos: 'ผู้อำนวยการ' }],
  audience: ['public'], consent: true, note: 'ขอเผยแพร่ก่อนวันศุกร์', albumUrl: 'https://www.facebook.com/media/set/?set=a.123',
};

let staff, student, external, pr, snap;
before(async () => {
  snap = await snapshot();
  [staff, student, external, pr] = await Promise.all(['staff', 'student', 'external', 'pr'].map(login));
  await staff.call('PUT', '/api/me/profile', { ...ID_STAFF, unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'นักประชาสัมพันธ์', consent: true });
  await external.call('PUT', '/api/me/profile', { ...ID_OTHER, org: 'บริษัทตัวอย่าง', consent: true });
  await pr.call('PUT', '/api/me/profile', { ...ID_STAFF, unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'PR', consent: true });
});
after(async () => {
  const r = await restore(snap);
  console.log(`cleanup: removed ${r.submissions} submissions, ${r.news} stories`);
});

describe('profile: name and phone', () => {
  const STAFF_UNIT = { unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'นักประชาสัมพันธ์', consent: true };
  test('required for every role, with a message per field', async () => {
    const r = await staff.call('PUT', '/api/me/profile', STAFF_UNIT);
    assert.equal(r.status, 400);
    for (const k of ['firstName', 'lastName', 'phone']) assert.ok(r.body.details[k], k);
    const e = await external.call('PUT', '/api/me/profile', { org: 'บริษัทตัวอย่าง', consent: true });
    for (const k of ['firstName', 'lastName', 'phone']) assert.ok(e.body.details[k], k);
  });
  test('staff: a 4-digit internal extension; students and external users: a 10-digit phone number', async () => {
    for (const phone of ['123', '12345', '081-234-5678', 'abcd', '0123']) {
      assert.equal((await staff.call('PUT', '/api/me/profile', { ...STAFF_UNIT, ...ID_STAFF, phone })).body.details?.phone && true, true, phone);
    }
    // 9 digits (077 123 456) and 11 digits are refused too: exactly 10, starting with 0
    for (const phone of ['1234', '81234567', '0812', '+66812345678', '077123456', '08123456789', '1812345678']) {
      assert.equal((await external.call('PUT', '/api/me/profile', { ...ID_OTHER, org: 'บริษัทตัวอย่าง', phone, consent: true })).status, 400, phone);
    }
    const ok = await external.call('PUT', '/api/me/profile', { ...ID_OTHER, org: 'บริษัทตัวอย่าง', phone: '077 123 4567', consent: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.phone, '0771234567', 'stored as digits');
  });
  test('the typed name becomes the display name and signing in again keeps it', async () => {
    const r = await staff.call('PUT', '/api/me/profile', { ...STAFF_UNIT, ...ID_STAFF });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.user.name, r.body.user.phone, r.body.user.onboarded], ['สมชาย ใจดี', '1234', true]);
    await login('staff');
    assert.equal((await staff.call('GET', '/api/me')).body.user.name, 'สมชาย ใจดี');
  });
});

describe('sending work', () => {
  test('rejects missing fields with a message per field', async () => {
    const r = await staff.call('POST', '/api/submissions', form({ type: 'news', credit: 'งานประชาสัมพันธ์ทดสอบ', title: 'x', audience: [] }));
    assert.equal(r.status, 400);
    for (const k of ['eventDate', 'categories', 'contentMode', 'photo', 'audience', 'consent']) assert.ok(r.body.details[k], k);
  });

  test('a day that does not exist is a field error, not a server error', async () => {
    for (const eventDate of ['2026-02-31', '2026-04-31', '0000-01-01']) {
      const r = await staff.call('POST', '/api/submissions', form({ ...NEWS, eventDate }, { photo: [['a.jpg', await img('#c33'), 'image/jpeg']] }));
      assert.equal(r.status, 400, eventDate);
      assert.ok(r.body.details?.eventDate, eventDate);
    }
  });

  test('external accounts cannot send', async () => {
    const r = await external.call('POST', '/api/submissions', form(NEWS, { photo: [['a.jpg', await img('#c33'), 'image/jpeg']] }));
    assert.equal(r.status, 403);
  });

  test('students send only for their own faculty', async () => {
    await student.call('PUT', '/api/me/profile', { ...ID_OTHER, unit: 'คณะนิติศาสตร์', major: 'นิติศาสตร์', year: 3, consent: true });
    const r = await student.call('POST', '/api/submissions', form(NEWS, { photo: [['a.jpg', await img('#c33'), 'image/jpeg']] }));
    assert.equal(r.status, 400);
    assert.ok(r.body.details.unit);
  });

  test('rejects a file that is not what its name says', async () => {
    const r = await staff.call('POST', '/api/submissions', form(NEWS, { photo: [['fake.jpg', Buffer.from('not an image'), 'image/jpeg']] }));
    assert.equal(r.status, 400);
  });

  test('rejects wrong file types per slot', async () => {
    const r = await staff.call('POST', '/api/submissions', form(NEWS, { photo: [['a.exe', Buffer.from('x'), 'application/octet-stream']] }));
    assert.equal(r.status, 400);
  });

  test('video files are never uploaded (videos are links)', async () => {
    const r = await staff.call('POST', '/api/submissions', form({ type: 'video', desc: 'คำอธิบายวิดีโอทดสอบ', title: 'วิดีโอ', eventDate: '2026-10-01', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
      videoPlatform: 'youtube', videoLink: 'https://youtu.be/dQw4w9WgXcQ', audience: ['staff'], consent: true }, { video: [['v.mp4', Buffer.from('x'), 'video/mp4']] }));
    assert.equal(r.status, 400);
  });
});

describe('full flow: send → PR asks for changes → resend → publish', () => {
  let ref, coverId;

  test('staff sends news with photos; server sets ref and status', async () => {
    const r = await staff.call('POST', '/api/submissions', form({ ...NEWS, ref: 'HACK', status: 'published' }, {
      photo: [['ภาพปก.jpg', await img('#d22'), 'image/jpeg'], ['ภาพที่สอง.jpg', await img('#22d'), 'image/jpeg']],
    }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const s = r.body.submission;
    assert.match(s.ref, /^NW-25\d\d-\d{4}$/);
    assert.equal(s.status, 'review');
    assert.equal(s.audience, 'บุคคลทั่วไป');
    assert.deepEqual(s.audienceValues, ['public', 'student', 'staff']);
    assert.deepEqual(s.fields.categories, ['ข่าวการศึกษา']);
    assert.deepEqual(s.history.map((h) => h.status), ['sent', 'review']);
    assert.equal(s.thread[0].from, 'me');
    assert.equal(s.files.length, 2);
    assert.equal(s.files[0].name, 'ภาพปก.jpg');
    assert.equal(s.fields.albumUrl, NEWS.albumUrl);
    assert.ok(s.files[0].cover);
    ref = s.ref;
    coverId = s.files[0].id;
  });

  test('album link must be an https link', async () => {
    const r = await staff.call('POST', '/api/submissions', form({ ...NEWS, albumUrl: 'javascript:alert(1)' }, { photo: [['a.jpg', await img('#d22'), 'image/jpeg']] }));
    assert.equal(r.status, 400);
    assert.ok(r.body.details.albumUrl);
  });

  test('web copy of a photo is resized to 1600px webp', async () => {
    const r = await staff.call('GET', `/api/files/${coverId}?v=web`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/webp');
    const meta = await sharp(r.body).metadata();
    assert.equal(meta.width, 1600);
  });

  test('others cannot see the work or its files', async () => {
    assert.equal((await student.call('GET', `/api/submissions/${ref}`)).status, 404);
    assert.equal((await student.call('GET', `/api/files/${coverId}`)).status, 404);
    assert.equal((await student.call('GET', '/api/pr/submissions')).status, 403);
  });

  test('sender cannot resend while PR is reviewing', async () => {
    const r = await staff.call('PUT', `/api/submissions/${ref}`, form(NEWS));
    assert.equal(r.status, 409);
  });

  test('PR sees it in the list as unread', async () => {
    const r = await pr.call('GET', '/api/pr/submissions?status=review');
    assert.equal(r.status, 200);
    const item = r.body.items.find((i) => i.ref === ref);
    assert.ok(item?.unread);
    assert.equal(item.sender.email, 'user@sru.ac.th');
    assert.ok(item.thumb);
    assert.ok(r.body.counts.review.total >= 1);
  });

  test('PR must say why when asking for changes', async () => {
    assert.equal((await pr.call('POST', `/api/pr/submissions/${ref}/status`, { status: 'revise' })).status, 400);
    const r = await pr.call('POST', `/api/pr/submissions/${ref}/status`, { status: 'revise', message: 'ขอภาพต้นฉบับเพิ่ม' });
    assert.equal(r.status, 200);
    assert.equal(r.body.submission.status, 'revise');
  });

  test('sender sees the PR message as unread, signed งานประชาสัมพันธ์', async () => {
    const r = await staff.call('GET', '/api/submissions');
    const s = r.body.submissions.find((x) => x.ref === ref);
    assert.ok(s.unread);
    assert.ok(r.body.unread >= 1);
    assert.deepEqual(s.thread.at(-1), { ...s.thread.at(-1), from: 'pr', name: 'งานประชาสัมพันธ์' });
    await staff.call('POST', `/api/submissions/${ref}/read`);
    assert.equal((await staff.call('GET', `/api/submissions/${ref}`)).body.submission.unread, false);
  });

  test('sender resends with one photo removed and one added', async () => {
    const second = (await staff.call('GET', `/api/submissions/${ref}`)).body.submission.files[1].id;
    const r = await staff.call('PUT', `/api/submissions/${ref}`, form({ ...NEWS, title: 'ค่ายนักวิทยาศาสตร์น้อย (แก้ไข)', removeFiles: [second] }, {
      photo: [['ภาพใหม่.png', await sharp({ create: { width: 800, height: 600, channels: 3, background: '#2a2' } }).png().toBuffer(), 'image/png']],
    }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = r.body.submission;
    assert.equal(s.status, 'review');
    assert.equal(s.title, 'ค่ายนักวิทยาศาสตร์น้อย (แก้ไข)');
    assert.deepEqual(s.files.map((f) => f.name), ['ภาพปก.jpg', 'ภาพใหม่.png']);
    assert.equal((await staff.call('GET', `/api/files/${second}`)).status, 404);
  });

  test('sender replies; PR sees it', async () => {
    assert.equal((await staff.call('POST', `/api/submissions/${ref}/messages`, { text: 'ส่งภาพเพิ่มแล้วครับ' })).status, 201);
    const r = await pr.call('GET', `/api/pr/submissions/${ref}`);
    assert.equal(r.body.submission.thread.at(-1).from, 'sender');
    assert.equal(r.body.sender.unit, 'สำนักงานอธิการบดี');
  });

  test('PR publishes; the story and its cover go public', async () => {
    const bad = await pr.call('POST', `/api/pr/submissions/${ref}/publish`, { body: 'สั้น' });
    assert.equal(bad.status, 400);
    const r = await pr.call('POST', `/api/pr/submissions/${ref}/publish`, {
      title: 'ค่ายนักวิทยาศาสตร์น้อย ประจำปี 2569', body: 'ข'.repeat(300), cover: coverId, featured: true,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.submission.status, 'published');
    assert.ok(r.body.news.cover_path);
    const media = await fetch(`${BASE}/media/${r.body.news.cover_path}`);
    assert.equal(media.status, 200);
    assert.equal((await pr.call('POST', `/api/pr/submissions/${ref}/status`, { status: 'review' })).status, 409);
    const mine = (await staff.call('GET', `/api/submissions/${ref}`)).body.submission;
    assert.equal(mine.status, 'published');
    assert.match(mine.url, /^news\.html\?id=/);
    // The sender's album link goes on to the story
    const story = (await staff.call('GET', `/api/news/${mine.newsId}`)).body.story;
    assert.equal(story.albumUrl, NEWS.albumUrl);
    assert.equal(story.albumHost, 'facebook');
    assert.deepEqual(mine.history.map((h) => h.status), ['sent', 'review', 'revise', 'resent', 'review', 'published']);
  });
});

describe('resending', () => {
  test('two resends at once (two tabs): one goes through, the other is refused', async () => {
    const png = async (bg) => sharp({ create: { width: 800, height: 600, channels: 3, background: bg } }).png().toBuffer();
    const sent = await staff.call('POST', '/api/submissions', form(NEWS, { photo: [['a.png', await png('#a22'), 'image/png']] }));
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const { ref } = sent.body.submission;
    assert.equal((await pr.call('POST', `/api/pr/submissions/${ref}/status`, { status: 'revise', message: 'ขอแก้คำโปรย' })).status, 200);
    const resend = async () => staff.call('PUT', `/api/submissions/${ref}`, form(NEWS, { photo: [['เพิ่ม.png', await png('#22a'), 'image/png']] }));
    const [a, b] = await Promise.all([resend(), resend()]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const s = (await staff.call('GET', `/api/submissions/${ref}`)).body.submission;
    assert.equal(s.files.length, 2, 'only one resend added its photo');
    assert.deepEqual(s.history.map((h) => h.status), ['sent', 'review', 'revise', 'resent', 'review']);
  });
});

describe('other types', () => {
  test('news written by PR starts as writing', async () => {
    const r = await staff.call('POST', '/api/submissions', form({ ...NEWS, contentMode: 'pr', body: '' }, {
      photo: [['a.jpg', await img('#999'), 'image/jpeg']], attach: [['กำหนดการ.pdf', Buffer.from('%PDF-1.4'), 'application/pdf']],
    }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.submission.status, 'writing');
    assert.ok(r.body.submission.prWrites);
    const pdf = r.body.submission.files.find((f) => f.kind === 'attach');
    const dl = await staff.call('GET', `/api/files/${pdf.id}`);
    assert.match(dl.headers.get('content-disposition'), /กำหนดการ|%E0%B8/);
  });

  test('video link must match its platform', async () => {
    const v = { type: 'video', desc: 'คำอธิบายวิดีโอทดสอบ', title: 'วิดีโอ', eventDate: '2026-10-01', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'], videoMode: 'link',
      videoPlatform: 'youtube', videoLink: 'https://www.facebook.com/x', audience: ['staff', 'student'], consent: true };
    assert.equal((await staff.call('POST', '/api/submissions', form(v))).status, 400);
    const r = await staff.call('POST', '/api/submissions', form({ ...v, videoLink: 'https://youtu.be/dQw4w9WgXcQ' }));
    assert.equal(r.status, 201);
    assert.match(r.body.submission.ref, /^VD-/);
    assert.equal(r.body.submission.audience, 'ภายในมหาวิทยาลัย');
  });
});

describe('reading news', () => {
  let id, cover;

  before(async () => {
    const sent = await staff.call('POST', '/api/submissions', form({ ...NEWS, title: 'ประกาศภายในสำหรับบุคลากร', audience: ['staff'] }, {
      photo: [['ปก.jpg', await img('#3a6'), 'image/jpeg'], ['สอง.jpg', await img('#63a'), 'image/jpeg']],
    }));
    const files = sent.body.submission.files;
    const r = await pr.call('POST', `/api/pr/submissions/${sent.body.submission.ref}/publish`, {
      body: 'ค'.repeat(200), cover: files[0].id, gallery: [files[1].id], titleEn: 'Staff notice',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    id = r.body.news.id;
    cover = `/media/${r.body.news.cover_path}`;
  });

  test('internal story is a locked card for signed-out readers and students', async () => {
    const anon = /** @type {any} */ (await (await fetch(`${BASE}/api/news?limit=48`)).json());
    const card = anon.items.find((n) => n.id === id);
    assert.deepEqual(Object.keys(card).sort(), ['audience', 'id', 'locked', 'publishedAt']);
    assert.ok((await student.call('GET', '/api/news?limit=48')).body.items.find((n) => n.id === id).locked);
    assert.equal((await staff.call('GET', '/api/news?limit=48')).body.items.find((n) => n.id === id).title, 'ประกาศภายในสำหรับบุคลากร');
  });

  test('search never finds internal stories the reader may not see', async () => {
    const q = encodeURIComponent('ประกาศภายในสำหรับบุคลากร');
    assert.equal((/** @type {any} */ (await (await fetch(`${BASE}/api/news/search?q=${q}`)).json())).items.filter((n) => n.id === id).length, 0);
    assert.equal((await student.call('GET', `/api/news/search?q=${q}`)).body.items.filter((n) => n.id === id).length, 0);
    assert.ok((await staff.call('GET', `/api/news/search?q=${q}`)).body.items.some((n) => n.id === id));
  });

  test('the story itself: sign in (401), wrong group (403), staff reads it', async () => {
    const anon = await fetch(`${BASE}/api/news/${id}`);
    assert.equal(anon.status, 401);
    assert.equal((/** @type {any} */ (await anon.json())).details.audience, 'เฉพาะบุคลากร');
    assert.equal((await student.call('GET', `/api/news/${id}`)).status, 403);
    const r = await staff.call('GET', `/api/news/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.story.titleEn, 'Staff notice');
    assert.equal(r.body.story.gallery.length, 1);
    assert.ok(r.body.related.every((n) => !n.locked));
  });

  test('images of internal stories need a reader of that group; full size has no EXIF', async () => {
    assert.equal((await fetch(BASE + cover)).status, 404);
    assert.equal((await student.call('GET', cover)).status, 404);
    const ok = await staff.call('GET', cover);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('cache-control'), /private/);
    const full = (await staff.call('GET', `/api/news/${id}`)).body.story.cover.full;
    const big = await staff.call('GET', full + '?download=1');
    assert.match(big.headers.get('content-disposition'), /attachment/);
    const meta = await sharp(big.body).metadata();
    assert.equal(meta.width, 2400);
    assert.equal(meta.exif, undefined);
  });

  test('public story images are cacheable by anyone', async () => {
    const pub = (/** @type {any} */ (await (await fetch(`${BASE}/api/news?limit=48`)).json())).items.find((n) => !n.locked && n.cover);
    const r = await fetch(BASE + pub.cover);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control'), /public/);
  });

  test('saved stories belong to the account', async () => {
    assert.equal((await fetch(`${BASE}/api/news/${id}/save`, { method: 'PUT' })).status, 401);
    assert.equal((await student.call('PUT', `/api/news/${id}/save`)).status, 404);
    assert.equal((await staff.call('PUT', `/api/news/${id}/save`)).status, 200);
    assert.ok((await staff.call('GET', '/api/me/saved')).body.ids.includes(id));
    assert.equal((await staff.call('GET', `/api/news/${id}`)).body.story.saved, true);
    await staff.call('DELETE', `/api/news/${id}/save`);
    assert.ok(!(await staff.call('GET', '/api/me/saved')).body.ids.includes(id));
  });

  test('archive counts by month and day', async () => {
    const a = /** @type {any} */ (await (await fetch(`${BASE}/api/news/archive`)).json());
    assert.ok(a.years.length >= 1);
    assert.ok(a.days[a.today] >= 1);
    assert.equal(Object.values(a.days).reduce((x, y) => x + y, 0), Object.values(a.months).reduce((x, y) => x + y, 0));
  });
});

describe('PR team', () => {
  test('only admins change the team', async () => {
    assert.equal((await pr.call('POST', '/api/pr/team', { email: 'new@sru.ac.th' })).status, 403);
    const admin = await login('admin');
    assert.equal((await admin.call('POST', '/api/pr/team', { email: 'User@Student.sru.ac.th' })).status, 201);
    assert.equal((await student.call('GET', '/api/me')).body.user.role, 'pr');
    assert.equal((await admin.call('DELETE', '/api/pr/team/user@student.sru.ac.th')).status, 200);
    assert.equal((await student.call('GET', '/api/me')).body.user.role, 'student');
  });
});
