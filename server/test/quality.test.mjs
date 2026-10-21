// Quality requirements: Thai text and search, privacy (GPS, phone numbers, nothing loaded from other sites),
// SEO (server-rendered story pages, Open Graph, sitemap, noindex) and the edit history of stories.
// What the tests create is removed afterwards (cleanup.mjs).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { query } from '../db.mjs';
import { thaiWords, searchTerms } from '../thai.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { BASE, ID_STAFF, anon, form, img, login, request } from './helpers.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const NEWS = {
  type: 'news', credit: 'งานประชาสัมพันธ์ทดสอบ', title: 'ทดสอบคุณภาพ', lead: 'สรุป', eventDate: '2026-10-10', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
  contentMode: 'own', body: 'ก'.repeat(160), audience: ['public'], consent: true,
};
let staff, pr, snap, publicId, internalId;
before(async () => {
  snap = await snapshot();
  [staff, pr] = await Promise.all([login('staff'), login('pr')]);
  await staff.call('PUT', '/api/me/profile', { ...ID_STAFF, unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'นักประชาสัมพันธ์', consent: true });
  publicId = (await query(`select id from news where 'public' = any(audience) and withdrawn_at is null and published_at <= now() order by published_at desc limit 1`)).rows[0].id;
  internalId = (await query(`select id from news where not ('public' = any(audience)) and withdrawn_at is null and published_at <= now() limit 1`)).rows[0]?.id;
});
after(async () => { await restore(snap); });

describe('Thai', () => {
  test('words are cut from Thai typed without spaces; small common words are left out', () => {
    assert.deepEqual(thaiWords('ค่ายอาสาชนบท'), ['ค่าย', 'อาสา', 'ชนบท']);
    assert.deepEqual(thaiWords('รางวัลชนะเลิศ2569'), ['รางวัล', 'ชนะ', 'เลิศ', '2569']);
    assert.deepEqual(searchTerms('การประกวด')[0].words, ['ประกวด']);
    assert.deepEqual(searchTerms('MOU')[0].words, []);
  });
  test('search finds a story by its words in any order, not only the exact phrase', async () => {
    const title = (await query(`select title from news where title like '%ลงนามความร่วมมือ%' and 'public' = any(audience) limit 1`)).rows[0]?.title;
    assert.ok(title, 'seed story with ลงนามความร่วมมือ');
    for (const q of ['ลงนามความร่วมมือ', 'ความร่วมมือลงนาม', 'ลงนามความร่วมมือโรงเรียน']) {
      const r = await anon.call('GET', `/api/news/search?q=${encodeURIComponent(q)}`);
      assert.ok(r.body.items.some((n) => n.title === title), `"${q}" finds "${title}"`);
    }
  });
  test('body text 1.7, story text 17px / 1.75 (Tailwind no longer resets it to 1.5)', () => {
    assert.match(readFileSync(join(ROOT, 'assets/src/app.css'), 'utf8'), /html \{ line-height: 1\.7; \}/);
    assert.match(readFileSync(join(ROOT, 'assets/app.css'), 'utf8'), /html\{line-height:1\.7[;}]/);
    assert.match(readFileSync(join(ROOT, 'news.html'), 'utf8'), /\.news-body p \{ font-size: 17px; line-height: 1\.75;/);
  });
  test('dates in the Buddhist era on the server-rendered story page', async () => {
    const r = await request('GET', `/news.html?id=${publicId}`);
    const t = String(r.body).match(/<time id="pubTime"[^>]*>([^<]+)</)[1];
    assert.match(t, /25\d\d/);
    assert.doesNotMatch(t, /20\d\d/);
  });
});

describe('privacy', () => {
  // TIFF inside the EXIF block: the number of entries left in the GPS directory
  function gpsEntries(exif) {
    const t = exif.toString('latin1', 0, 6) === 'Exif\0\0' ? 6 : 0;
    const le = exif[t] === 0x49;
    const u16 = (o) => (le ? exif.readUInt16LE(t + o) : exif.readUInt16BE(t + o)), u32 = (o) => (le ? exif.readUInt32LE(t + o) : exif.readUInt32BE(t + o));
    const ifd0 = u32(4);
    for (let i = 0; i < u16(ifd0); i++) if (u16(ifd0 + 2 + i * 12) === 0x8825) return u16(u32(ifd0 + 2 + i * 12 + 8));
    return null;
  }
  test('photos keep their quality but not where they were taken (GPS removed from the original)', async () => {
    const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#3a6' } })
      .withExif({ IFD0: { Make: 'TestPhone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '9/1 8/1 3000/100', GPSLongitudeRef: 'E', GPSLongitude: '99/1 20/1 1234/100' } })
      .jpeg({ quality: 92 }).toBuffer();
    assert.ok(gpsEntries((await sharp(photo).metadata()).exif) > 0, 'test photo has GPS');
    const sent = await staff.call('POST', '/api/submissions', form(NEWS, { photo: [['ภาพมี GPS.jpg', photo, 'image/jpeg']] }));
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const file = sent.body.submission.files[0];
    const got = await pr.call('GET', `/api/files/${file.id}`);
    assert.equal(got.status, 200);
    const meta = await sharp(got.body).metadata();
    assert.equal(gpsEntries(meta.exif), 0, 'GPS directory emptied');
    assert.match(meta.exif.toString('latin1'), /TestPhone/, 'other camera data kept');
    assert.equal(got.body.length, photo.length, 'not re-encoded (same size)');
    assert.ok((await sharp(got.body).raw().toBuffer()).equals(await sharp(photo).raw().toBuffer()), 'same pixels');
  });
  test('phone numbers: the PR desk sees the sender\'s, readers never do', async () => {
    const sent = await staff.call('POST', '/api/submissions', form(NEWS, { photo: [['a.jpg', await img('#468', 800, 600), 'image/jpeg']] }));
    const detail = await pr.call('GET', `/api/pr/submissions/${sent.body.submission.ref}`);
    assert.equal(detail.body.sender.phone, ID_STAFF.phone);
    const reader = await login('student');
    for (const path of ['/api/news?limit=48', '/api/news/search?q=ข่าว', `/api/news/${publicId}`, '/api/news/archive']) {
      for (const who of [anon, reader]) {
        const r = await who.call('GET', path);
        assert.ok(!JSON.stringify(r.body).includes(`"phone"`), `${path}: no phone field`);
      }
    }
  });
  test('reader pages load nothing from other sites (fonts, CSS, scripts, images are on this server)', () => {
    const external = [];
    for (const f of readdirSync(ROOT).filter((x) => x.endsWith('.html'))) {
      const html = readFileSync(join(ROOT, f), 'utf8');
      for (const m of html.matchAll(/<(script|link|img|iframe|source)\b[^>]*\b(src|href|srcset)="(https?:)?\/\/([^/"]+)/g)) {
        if (f === 'login.html' && m[4] === 'accounts.google.com') continue; // Google sign-in itself
        external.push(`${f}: ${m[1]} ${m[4]}`);
      }
    }
    for (const f of ['assets/app.css', 'assets/fonts.css', 'desk.css']) {
      for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(/url\((["']?)(https?:)?\/\/([^/)'"]+)/g)) external.push(`${f}: url ${m[3]}`);
    }
    assert.deepEqual(external, []);
  });
  test('the story page asks for YouTube thumbnails from this server only, and only for videos of stories', async () => {
    assert.equal((await anon.call('GET', '/media/video/AAAAAAAAAAA.webp')).status, 404);
    assert.equal((await anon.call('GET', '/media/video/..%2F..%2F.env')).status, 404);
  });
});

describe('SEO', () => {
  test('a public story page comes with its content, Open Graph, canonical URL and NewsArticle data', async () => {
    const r = await request('GET', `/news.html?id=${publicId}`);
    const html = String(r.body);
    const n = (await query('select title, lead from news where id = $1', [publicId])).rows[0];
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-robots-tag'), null);
    assert.ok(html.includes(`<meta property="og:title" content="${n.title.replace(/"/g, '&quot;')}">`));
    assert.match(html, /<meta property="og:image" content="https?:\/\/[^"]+">/);
    assert.match(html, /<link rel="canonical" href="[^"]+\/news\.html\?id=/);
    assert.match(html, /<script type="application\/ld\+json">\{"@context":"https:\/\/schema.org","@type":"NewsArticle"/);
    assert.ok(html.includes(`data-i18n="title">${n.title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</h1>`), 'title in the markup');
    assert.match(html, /<article id="article" lang="th">/);
    assert.doesNotMatch(html, /window\.__NEWS = [^;]*<\/script/i, 'no </script> inside the inline JSON');
  });
  test('internal stories: noindex and no content for readers who may not read them; 404 / noindex for missing ones', async () => {
    if (internalId) {
      const r = await request('GET', `/news.html?id=${internalId}`);
      const title = (await query('select title from news where id = $1', [internalId])).rows[0].title;
      assert.match(r.headers.get('x-robots-tag') || '', /noindex/);
      assert.ok(!String(r.body).includes(title), 'title not in the page');
    }
    const missing = await request('GET', '/news.html?id=00000000-0000-4000-8000-000000000000');
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('x-robots-tag') || '', /noindex/);
  });
  test('sitemap.xml lists public stories only; robots.txt and back-office pages keep crawlers out', async () => {
    const sm = String((await request('GET', '/sitemap.xml')).body);
    assert.ok(sm.includes(`/news.html?id=${publicId}</loc>`));
    if (internalId) assert.ok(!sm.includes(internalId));
    const robots = String((await request('GET', '/robots.txt')).body);
    for (const line of ['Disallow: /api/', 'Disallow: /admin.html', 'Disallow: /pr.html']) assert.ok(robots.includes(line), line);
    assert.match(robots, /Sitemap: .+\/sitemap\.xml/);
    for (const page of ['/admin.html', '/pr.html', '/login.html', '/submit.html']) assert.match((await request('GET', page)).headers.get('x-robots-tag') || '', /noindex/, page);
    assert.equal((await request('GET', '/index.html')).headers.get('x-robots-tag'), null);
  });
  test('search page: results, heading and filter bar come from the server as the script shows them (no jump on a phone)', async () => {
    const html = String((await request('GET', `/search.html?q=${encodeURIComponent('ทดสอบคุณภาพ $&')}`)).body);
    assert.match(html, /window\.__SEARCH = \{"query":/);
    assert.match(html, /<form id="bigSearch" role="search" action="search.html">/);
    assert.match(html, /<button id="clear"[^>]*class="[^"]*"\s*>/, '"ล้างตัวกรอง" shown');
    assert.match(html, /<label id="sortBox"[^>]*class="[^"]*">/, '"เรียงตาม" shown');
    assert.ok(html.includes('id="resultTitle" class="font-display text-[22px] font-semibold text-royal">ผลการค้นหา “ทดสอบคุณภาพ $&amp;”<'), 'heading, with the words escaped');
    const plain = String((await request('GET', '/search.html')).body);
    assert.match(plain, /<button id="clear"[^>]*hidden>/, 'nothing to clear');
    assert.match(plain, /<label id="sortBox"[^>]*hidden>/);
  });
});

describe('edit history of stories', () => {
  test('every change is kept with who made it, what changed and the version after it', async () => {
    const before = (await query('select featured, (select count(*)::int from news_revisions where news_id = $1) revs, (select coalesce(max(id), 0) from news_revisions) last from news where id = $1', [publicId])).rows[0];
    await pr.call('POST', `/api/pr/news/${publicId}/feature`, { featured: !before.featured });
    await pr.call('POST', `/api/pr/news/${publicId}/withdraw`, { reason: 'ทดสอบประวัติการแก้ไข' });
    await pr.call('POST', `/api/pr/news/${publicId}/restore`, {});
    await query('update news set views = views + 1 where id = $1', [publicId]); // a read, not an edit
    const h = (await pr.call('GET', `/api/pr/news/${publicId}/revisions`)).body.items;
    assert.equal(h.length, before.revs + 3);
    assert.deepEqual(h.slice(0, 3).map((x) => x.action), ['restored', 'withdrawn', before.featured ? 'unfeatured' : 'featured']);
    assert.ok(h.slice(0, 3).every((x) => x.actor?.email === 'pr@sru.ac.th'));
    assert.equal(h[1].changes.find((c) => c.field === 'withdrawn_reason').to, 'ทดสอบประวัติการแก้ไข');
    assert.equal(h.at(-1).action, 'created');
    assert.equal((await staff.call('GET', `/api/pr/news/${publicId}/revisions`)).status, 403);
    // back as it was
    await query('alter table news disable trigger news_revision');
    await query('update news set featured = $2, views = views - 1 where id = $1', [publicId, before.featured]);
    await query('alter table news enable trigger news_revision');
    // Only the rows this test made (a story seeded minutes ago keeps its own)
    await query('delete from news_revisions where news_id = $1 and id > $2', [publicId, before.last]);
  });
  test('the back office history (audit log) has the mail and privacy actions (and the old เล่มสรุปข่าว ones, for their history)', async () => {
    const { ACTIONS } = await import('../audit.mjs');
    for (const a of ['digest.reset', 'digest.file', 'mail.test', 'news.withdraw', 'privacy.erase']) assert.ok(ACTIONS[a], a);
  });
});
