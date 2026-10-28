// Back office: import, withdraw, search, reads, reports, settings, roles, history.
// What the tests create is removed again afterwards (cleanup.mjs).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import ExcelJS from 'exceljs';
import { parsePost, fbUrl } from '../newsdesk.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { BASE, BROWSER_UA, ID_STAFF, anon, form, img, login } from './helpers.mjs';

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
const daysAgo = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(Date.now() - n * 86400000));
const IMPORT = {
  kind: 'news', credit: 'งานประชาสัมพันธ์ทดสอบ', title: 'ทดสอบนำเข้า สัมมนาวิชาการครูภาษาไทยระดับภูมิภาค', lead: 'สัมมนาครูภาษาไทย',
  body: 'คณะครุศาสตร์จัดสัมมนาวิชาการสำหรับครูภาษาไทยในภูมิภาค มีครูเข้าร่วมกว่าสองร้อยคน', unit: 'คณะครุศาสตร์',
  categories: ['ข่าวประชุม/สัมมนา'], audience: ['public'], date: daysAgo(9), time: '09:30',
  sourceUrl: 'https://m.facebook.com/sru.pr/posts/pfbid0TEST123?__cft__=abc&ref=share',
};

let staff, pr, admin, coord, snap, originals;
before(async () => {
  snap = await snapshot();
  [staff, , pr, admin, coord] = await Promise.all(['staff', 'student', 'pr', 'admin', 'coordinator'].map(login));
  originals = (await admin.call('GET', '/api/admin/settings')).body.settings;
  await staff.call('PUT', '/api/me/profile', { ...ID_STAFF, unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'นักประชาสัมพันธ์', consent: true });
});
after(async () => {
  // Settings back through the API so the server's cache matches the database again
  for (const k of ['categories', 'photos', 'messages', 'org']) await admin.call('PUT', `/api/admin/settings/${k}`, { value: originals[k] });
  const r = await restore(snap);
  console.log(`cleanup: removed ${r.submissions} submissions, ${r.news} stories`);
});

describe('import (นำเข้าข่าวย้อนหลัง)', () => {
  let id;

  test('Facebook links are normalised; other sites are refused', async () => {
    assert.equal(fbUrl('https://m.facebook.com/sru.pr/posts/123?__cft__=x&ref=y'), 'https://www.facebook.com/sru.pr/posts/123');
    assert.equal(fbUrl('https://www.facebook.com/permalink.php?story_fbid=9&id=7&x=1'), 'https://www.facebook.com/permalink.php?story_fbid=9&id=7');
    assert.equal(fbUrl('https://evil.example/facebook.com/x'), null);
    assert.equal((await pr.call('POST', '/api/pr/import/fetch', { url: 'http://127.0.0.1/admin' })).status, 400);
  });

  test('reads text, photos and date from a post page', () => {
    const post = parsePost(`<html><head>
      <meta property="og:title" content="งานประชาสัมพันธ์ มรส." />
      <meta property="og:description" content="หัวข้อข่าว &amp; กิจกรรม&#10;รายละเอียดบรรทัดสอง..." />
      <meta property="og:image" content="https://scontent.fbkk1-1.fna.fbcdn.net/v/a.jpg?x=1" />
      <meta property="og:image" content="https://scontent.fbkk1-1.fna.fbcdn.net/v/b.jpg" />
      </head><body><script>{"publish_time":1759980000}</script></body></html>`);
    assert.equal(post.text, 'หัวข้อข่าว & กิจกรรม\nรายละเอียดบรรทัดสอง...');
    assert.ok(post.truncated);
    assert.equal(post.images.length, 2);
    assert.equal(post.date, '2025-10-09');
  });

  test('only PR may import; fields are checked', async () => {
    assert.equal((await staff.call('POST', '/api/pr/import', form(IMPORT, { photo: [['a.jpg', await img('#468'), 'image/jpeg']] }))).status, 403);
    const r = await pr.call('POST', '/api/pr/import', form({ ...IMPORT, unit: 'หน่วยงานที่ไม่มี', date: daysAgo(-3) }));
    assert.equal(r.status, 400);
    assert.ok(r.body.details.unit && r.body.details.date && r.body.details.photos);
  });

  test('imports at the original date, live at once, no submission', async () => {
    // Seed stories keep the dates of the day they were seeded, so one of them may come near this date: confirmed here,
    // the warning itself is checked below
    const r = await pr.call('POST', '/api/pr/import', form({ ...IMPORT, confirmDuplicate: true }, { photo: [['ปก.jpg', await img('#468'), 'image/jpeg'], ['สอง.jpg', await img('#864'), 'image/jpeg']] }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    id = r.body.news.id;
    assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(r.body.news.publishedAt)), IMPORT.date);
    const story = (await anon.call('GET', `/api/news/${id}`)).body.story;
    assert.equal(story.gallery.length, 1);
    assert.ok(story.cover.full);
  });

  test('"more photos" link: set, checked and shown on the story', async () => {
    assert.equal((await pr.call('PUT', `/api/pr/news/${id}/album`, { albumUrl: 'javascript:alert(1)' })).body.details.albumUrl.length > 0, true);
    assert.equal((await staff.call('PUT', `/api/pr/news/${id}/album`, { albumUrl: 'https://drive.google.com/drive/folders/abc' })).status, 403);
    const r = await pr.call('PUT', `/api/pr/news/${id}/album`, { albumUrl: 'https://drive.google.com/drive/folders/abc' });
    assert.equal(r.status, 200);
    const story = (await anon.call('GET', `/api/news/${id}`)).body.story;
    assert.equal(story.albumUrl, 'https://drive.google.com/drive/folders/abc');
    assert.equal(story.albumHost, 'drive');
    await pr.call('PUT', `/api/pr/news/${id}/album`, { albumUrl: '' });
    assert.equal((await anon.call('GET', `/api/news/${id}`)).body.story.albumUrl, null);
  });

  test('downloads all photos as one ZIP, full size, in page order', async () => {
    const r = await anon.call('GET', `/media/${id}/photos.zip`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment/);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(r.body);
    assert.deepEqual(Object.keys(zip.files), ['01.jpg', '02.jpg']);
    assert.equal((await anon.call('GET', '/media/00000000-0000-0000-0000-000000000000/photos.zip')).status, 404);
  });

  test('in the home page feed at its original date, and in the archive, search, unit page and the PR list', async () => {
    const feed = (await anon.call('GET', `/api/news?feed=1&date=${IMPORT.date}&limit=48`)).body.items;
    assert.ok(feed.some((n) => n.id === id));
    const day = (await anon.call('GET', `/api/news?date=${IMPORT.date}&limit=48`)).body.items;
    assert.ok(day.some((n) => n.id === id));
    assert.ok((await anon.call('GET', '/api/news/archive')).body.days[IMPORT.date] >= 1);
    assert.ok((await anon.call('GET', `/api/news/search?q=${encodeURIComponent('สัมมนาครูภาษาไทย')}`)).body.items.some((n) => n.id === id));
    assert.ok((await anon.call('GET', `/api/news/search?unit=${encodeURIComponent('คณะครุศาสตร์')}`)).body.items.some((n) => n.id === id));
    const desk = (await pr.call('GET', '/api/pr/news?show=imported')).body;
    assert.ok(desk.items.find((n) => n.id === id).imported);
    assert.ok(desk.counts.imported >= 1);
  });

  test('no duplicate check: the same post imports again without being asked', async () => {
    assert.equal((await pr.call('GET', `/api/pr/import/check?unit=${encodeURIComponent('คณะครุศาสตร์')}`)).status, 404);
    const again = await pr.call('POST', '/api/pr/import', form({ ...IMPORT, title: 'อีกข่าวหนึ่ง' }, { photo: [['a.jpg', await img('#468'), 'image/jpeg']] }));
    assert.equal(again.status, 201, JSON.stringify(again.body));
  });

  test('every kind needs its text; a banner needs ผู้ออกแบบ or ที่มา, which the story keeps', async () => {
    const pic = { photo: [['a.jpg', await img('#468'), 'image/jpeg']] };
    const banner = { ...IMPORT, kind: 'banner', title: 'อินโฟกราฟิกทดสอบที่มา', categories: ['ข่าวการศึกษา'] };
    const noText = await pr.call('POST', '/api/pr/import', form({ ...banner, body: '', credit: 'กระทรวง อว.' }, pic));
    assert.equal(noText.status, 400);
    assert.ok(noText.body.details.body);
    const noCredit = await pr.call('POST', '/api/pr/import', form({ ...banner, body: 'ข้อความประกอบ', credit: '', creditKind: 'source' }, pic));
    assert.equal(noCredit.body.details.credit, 'กรอกที่มาของงาน');
    const ok = await pr.call('POST', '/api/pr/import', form({ ...banner, body: 'ข้อความประกอบ', credit: 'กระทรวง อว.', creditKind: 'source',
      albumUrl: 'https://www.facebook.com/media/set/?set=a.1', albumLinks: ['https://drive.google.com/drive/folders/abc', 'https://www.facebook.com/media/set/?set=a.1'] }, pic));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const s = (await anon.call('GET', `/api/news/${ok.body.news.id}`)).body.story;
    assert.equal(s.creditKind, 'source');
    assert.equal(s.credit, 'กระทรวง อว.');
    // The first link is the main one; the same link twice is kept once
    assert.equal(s.albumUrl, 'https://www.facebook.com/media/set/?set=a.1');
    assert.deepEqual(s.albumLinks, [{ url: 'https://drive.google.com/drive/folders/abc', host: 'drive' }]);
    const bad = await pr.call('POST', '/api/pr/import', form({ ...banner, body: 'ข้อความ', credit: 'x', albumLinks: ['http://insecure.example'] }, pic));
    assert.equal(bad.status, 400);
    assert.ok(bad.body.details.albumLinks);
  });

  test('ข่าวพร้อมภาพ: เครดิตภาพ or ที่มา must be filled; ที่มา is kept on the story', async () => {
    const pic = { photo: [['a.jpg', await img('#468'), 'image/jpeg']] };
    const none = await pr.call('POST', '/api/pr/import', form({ ...IMPORT, title: 'ไม่มีเครดิตภาพ', credit: '' }, pic));
    assert.equal(none.body.details?.credit, 'กรอกเครดิตภาพ');
    const none2 = await pr.call('POST', '/api/pr/import', form({ ...IMPORT, title: 'ไม่มีที่มา', credit: '', creditKind: 'source' }, pic));
    assert.equal(none2.body.details?.credit, 'กรอกที่มาของภาพ');
    const ok = await pr.call('POST', '/api/pr/import', form({ ...IMPORT, title: 'ภาพจากเพจคณะ', credit: 'เพจคณะครุศาสตร์', creditKind: 'source' }, pic));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal((await anon.call('GET', `/api/news/${ok.body.news.id}`)).body.story.creditKind, 'source');
    const photo = await pr.call('POST', '/api/pr/import', form({ ...IMPORT, title: 'ภาพของงาน PR', creditKind: 'photo' }, pic));
    assert.equal((await anon.call('GET', `/api/news/${photo.body.news.id}`)).body.story.creditKind, null);
  });

  test('เพิ่มข่าว (fresh): not an import, may be set for later; interns cannot', async () => {
    const later = new Date(Date.now() + 3 * 86400000);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(later);
    const r = await pr.call('POST', '/api/pr/import', form({ ...IMPORT, title: `ข่าวที่ PR เพิ่มเอง ${Date.now()}`, sourceUrl: null, date, time: '14:30', fresh: true },
      { photo: [['a.jpg', await img('#468'), 'image/jpeg']] }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const desk = (await pr.call('GET', '/api/pr/news?show=scheduled')).body.items.find((n) => n.id === r.body.news.id);
    assert.ok(desk && !desk.imported);
    // An import may not be in the future
    const past = await pr.call('POST', '/api/pr/import', form({ ...IMPORT, title: 'นำเข้าวันพรุ่งนี้', date, time: '14:30' }, { photo: [['a.jpg', await img('#468'), 'image/jpeg']] }));
    assert.equal(past.status, 400);
    const intern = await login('intern');
    const no = await intern.call('POST', '/api/pr/import', form({ ...IMPORT, title: 'ฝึกงานเพิ่มข่าว', fresh: true }, { photo: [['a.jpg', await img('#468'), 'image/jpeg']] }));
    assert.equal(no.status, 403);
  });

  test('every import is in the usage history', async () => {
    const h = (await admin.call('GET', '/api/admin/audit?action=news.import')).body;
    assert.ok(h.items.some((x) => x.target === id && x.actorEmail === 'pr@sru.ac.th'));
  });

  test('withdraw: the story page answers 410 with the reason, its images go, restore brings it back', async () => {
    const cover = (await anon.call('GET', `/api/news/${id}`)).body.story.cover.web;
    assert.equal((await pr.call('POST', `/api/pr/news/${id}/withdraw`, {})).status, 400);
    assert.equal((await pr.call('POST', `/api/pr/news/${id}/withdraw`, { reason: 'ข้อมูลในข่าวคลาดเคลื่อน' })).status, 200);
    const gone = await anon.call('GET', `/api/news/${id}`);
    assert.equal(gone.status, 410);
    assert.equal(gone.body.details.reason, 'ข้อมูลในข่าวคลาดเคลื่อน');
    assert.equal((await fetch(BASE + cover)).status, 404);
    assert.ok(!(await anon.call('GET', `/api/news?date=${IMPORT.date}`)).body.items.some((n) => n.id === id));
    assert.equal((await pr.call('POST', `/api/pr/news/${id}/restore`)).status, 200);
    assert.equal((await anon.call('GET', `/api/news/${id}`)).status, 200);
  });
});

describe('search', () => {
  test('a title match ranks above a body-only match; a small typo still finds it', async () => {
    const term = encodeURIComponent('เกษตรอัจฉริยะ');
    const r = (await anon.call('GET', `/api/news/search?q=${term}`)).body;
    assert.ok(r.items[0].title.includes('เกษตรอัจฉริยะ'));
    const typo = (await anon.call('GET', `/api/news/search?q=${encodeURIComponent('เกษตรอัฉริยะ')}`)).body;
    assert.ok(typo.items.some((n) => n.title.includes('เกษตรอัจฉริยะ')));
  });

  test('filters: kind, category, unit (with its sub-units) and dates', async () => {
    const all = (await anon.call('GET', '/api/news/search?limit=48')).body.items;
    const cat = (await anon.call('GET', `/api/news/search?cat=${encodeURIComponent('ข่าววิจัย/นวัตกรรม')}&limit=48`)).body.items;
    assert.ok(cat.length && cat.every((n) => n.categories.includes('ข่าววิจัย/นวัตกรรม')));
    assert.ok((await anon.call('GET', '/api/news/search?kind=banner')).body.items.every((n) => n.kind === 'banner'));
    const from = daysAgo(1);
    const recent = (await anon.call('GET', `/api/news/search?from=${from}&to=${today}&limit=48`)).body.items;
    assert.ok(recent.length < all.length);
    assert.ok(recent.every((n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(n.publishedAt)) >= from));
  });

  test('results have a snippet around the match', async () => {
    const r = (await anon.call('GET', `/api/news/search?q=${encodeURIComponent('วัตถุประสงค์')}`)).body;
    assert.ok(r.items.length && r.items[0].snippet.includes('วัตถุประสงค์'));
  });
});

describe('reads', () => {
  let id;
  // A new story each run: an account counts once per story per day, and tests run many times a day
  before(async () => {
    const r = await pr.call('POST', '/api/pr/import', form({ ...IMPORT, title: `ทดสอบยอดอ่าน ${Date.now()}`, sourceUrl: null, date: today, time: '00:01', confirmDuplicate: true },
      { photo: [['r.jpg', await img('#468', 800, 600), 'image/jpeg']] }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    id = r.body.news.id;
  });

  test('once per reader per story per day; bots are not counted', async () => {
    const views = (await anon.call('GET', `/api/news/${id}`)).body.story.views;
    const ua = { 'User-Agent': BROWSER_UA + ' test-' + Math.random() };
    assert.equal((await anon.call('POST', `/api/news/${id}/read`, { ref: 'https://www.google.com/' }, ua)).body.counted, true);
    assert.equal((await anon.call('POST', `/api/news/${id}/read`, { ref: 'https://www.google.com/' }, ua)).body.counted, false);
    assert.equal((await anon.call('POST', `/api/news/${id}/read`, {}, { 'User-Agent': 'Googlebot/2.1' })).body.counted, false);
    assert.equal((await staff.call('POST', `/api/news/${id}/read`, { ref: 'https://l.facebook.com/' }, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' })).body.counted, true);
    assert.equal((await anon.call('GET', `/api/news/${id}`)).body.story.views, views + 2);
  });
});

describe('reports', () => {
  test('PR sees every unit; read sources and devices are counted', async () => {
    const r = (await pr.call('GET', `/api/reports?from=${daysAgo(60)}&to=${today}`)).body;
    assert.ok(r.totals.stories > 0);
    assert.ok(new Set(r.matrix.map((m) => m.unit)).size > 1);
    assert.ok(r.reads.sources.search >= 1 && r.reads.devices.mobile >= 1);
    assert.ok(r.reads.top.length > 0);
    assert.ok('review' in r.approval && 'avgHours' in r.approval);
  });

  test('a coordinator sees only their own unit, whatever they ask for', async () => {
    assert.equal((await coord.call('GET', '/api/me')).body.user.coordUnit, 'คณะครุศาสตร์');
    const r = (await coord.call('GET', `/api/reports?from=${daysAgo(60)}&to=${today}&unit=${encodeURIComponent('คณะนิติศาสตร์')}`)).body;
    assert.equal(r.unit, 'คณะครุศาสตร์');
    assert.ok(r.matrix.every((m) => m.unit === 'คณะครุศาสตร์'));
    assert.equal((await staff.call('GET', '/api/reports')).status, 403);
    assert.equal((await coord.call('GET', '/api/pr/news')).status, 403);
  });

  test('exports an Excel workbook', async () => {
    const r = await pr.call('GET', `/api/reports/export.xlsx?from=${daysAgo(60)}&to=${today}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['สรุป', 'หน่วยงาน×ประเภท×เดือน', 'ยอดอ่าน 10 อันดับ', 'แหล่งที่มาและอุปกรณ์']);
  });
});

describe('settings, roles and history', () => {
  test('admin only', async () => {
    assert.equal((await pr.call('GET', '/api/admin/settings')).status, 403);
    assert.equal((await pr.call('PUT', '/api/admin/settings/categories', { value: ['x'] })).status, 403);
  });

  test('categories: checked, saved, used by the site and by the server checks', async () => {
    assert.equal((await admin.call('PUT', '/api/admin/settings/categories', { value: [] })).status, 400);
    const next = [...originals.categories, 'ข่าวกีฬา'];
    assert.equal((await admin.call('PUT', '/api/admin/settings/categories', { value: next })).status, 200);
    const site = await (await fetch(`${BASE}/site-config.js`)).text();
    assert.ok(site.includes('ข่าวกีฬา'));
    const r = await staff.call('POST', '/api/submissions', form({ type: 'video', desc: 'คำอธิบายวิดีโอทดสอบ', title: 'วิดีโอกีฬา', eventDate: today, unit: 'กองกลาง', categories: ['ข่าวกีฬา'],
      videoPlatform: 'youtube', videoLink: 'https://youtu.be/dQw4w9WgXcQ', audience: ['staff'], consent: true }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  test('photo limits apply to submissions', async () => {
    assert.equal((await admin.call('PUT', '/api/admin/settings/photos', { value: { min: 5, max: 2 } })).status, 400);
    assert.equal((await admin.call('PUT', '/api/admin/settings/photos', { value: { min: 2, max: 10 } })).status, 200);
    const r = await staff.call('POST', '/api/submissions', form({ type: 'news', credit: 'งานประชาสัมพันธ์ทดสอบ', title: 'ภาพเดียว', lead: 'x', eventDate: today, unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
      contentMode: 'own', body: 'ก'.repeat(160), audience: ['staff'], consent: true }, { photo: [['a.jpg', await img('#468'), 'image/jpeg']] }));
    assert.equal(r.status, 400);
    assert.match(r.body.details.photo, /อย่างน้อย 2 ภาพ/);
  });

  test('org chart: a saved chart is served as /org-data.js and checked by the server', async () => {
    const base = structuredClone(originals.org || (await admin.call('GET', '/api/admin/settings')).body.fileOrg);
    base.staffGroups[0].units.push('ศูนย์ทดสอบระบบ');
    assert.equal((await admin.call('PUT', '/api/admin/settings/org', { value: base })).status, 200);
    assert.ok((await (await fetch(`${BASE}/org-data.js`)).text()).includes('ศูนย์ทดสอบระบบ'));
    const r = await pr.call('POST', '/api/pr/import', form({ ...IMPORT, unit: 'ศูนย์ทดสอบระบบ', title: 'ข่าวของศูนย์ทดสอบ', sourceUrl: null, date: daysAgo(30) }, { photo: [['a.jpg', await img('#468'), 'image/jpeg']] }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await admin.call('PUT', '/api/admin/settings/org', { value: null })).status, 200);
    assert.ok(!(await (await fetch(`${BASE}/org-data.js`)).text()).includes('ศูนย์ทดสอบระบบ'));
  });

  test('message templates: the published message comes from settings', async () => {
    const messages = { ...originals.messages, published: 'ทดสอบ: ข่าวขึ้นเว็บแล้ว' };
    assert.equal((await admin.call('PUT', '/api/admin/settings/messages', { value: messages })).status, 200);
    assert.equal((await pr.call('GET', '/api/pr/config')).body.messages.published, 'ทดสอบ: ข่าวขึ้นเว็บแล้ว');
  });

  test('roles: coordinator needs a unit; admin cannot demote themselves; changes are in the history', async () => {
    assert.equal((await admin.call('PUT', '/api/admin/roles', { email: 'new.coord@sru.ac.th', role: 'coordinator' })).status, 400);
    assert.equal((await admin.call('PUT', '/api/admin/roles', { email: 'new.coord@sru.ac.th', role: 'coordinator', unit: 'คณะนิติศาสตร์' })).status, 200);
    const list = (await admin.call('GET', '/api/admin/users?q=new.coord')).body.items;
    assert.equal(list[0].role, 'coordinator');
    assert.equal(list[0].coordUnit, 'คณะนิติศาสตร์');
    assert.equal(list[0].signedIn, false);
    assert.equal((await admin.call('PUT', '/api/admin/roles', { email: 'admin@sru.ac.th', role: 'default' })).status, 409);
    assert.equal((await admin.call('PUT', '/api/admin/roles', { email: 'new.coord@sru.ac.th', role: 'default' })).status, 200);
    const h = (await admin.call('GET', '/api/admin/audit?q=new.coord')).body.items;
    assert.deepEqual(h.map((x) => x.action), ['role.remove', 'role.set']);
    const s = (await admin.call('GET', '/api/admin/audit?action=settings.update')).body.items;
    assert.ok(s.some((x) => x.target === 'categories'));
  });
});
