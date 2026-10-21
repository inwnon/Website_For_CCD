// เล่มสรุปข่าว as pictures (migration 021): the pages drawn in the studio, kept with their text and links,
// shown only while the issue still looks as it did; the automatic layout uses public stories, the most read first.
// Needs the sample data: npm run db:seed. What the tests change is put back afterwards (cleanup.mjs).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { query } from '../db.mjs';
import { autoGroups, pool } from '../digests.mjs';
import { load as loadSettings } from '../settings.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { BASE, anon, login } from './helpers.mjs';

let pr, staff, snap, published;
before(async () => {
  snap = await snapshot();
  await loadSettings();
  [pr, staff] = await Promise.all(['pr', 'staff'].map(login));
  published = (await pr.call('GET', '/api/pr/digests')).body.items.find((d) => d.status === 'published' && d.mode !== 'pdf');
  assert.ok(published, 'run npm run db:seed first');
});
after(async () => { await restore(snap); });

const page = (color, w = 1240, h = 1754) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).webp().toBuffer();
async function send(id, n, { meta, files } = {}) {
  const fd = new FormData();
  const list = files || await Promise.all(Array.from({ length: n }, (_, i) => page(i % 2 ? '#eee' : '#ddd')));
  list.forEach((b, i) => fd.append('page', new Blob([b], { type: 'image/webp' }), `p${i + 1}.webp`));
  fd.append('meta', JSON.stringify(meta || Array.from({ length: n }, (_, i) => ({ body: `หน้าที่ ${i + 1} ค่ายอาสาทดสอบภาพหน้า`, links: [] }))));
  return pr.call('PUT', `/api/pr/digests/${id}/pages`, fd);
}

describe('page pictures', () => {
  test('PR only; every page, as WebP; links kept only if they go somewhere in the site or the book', async () => {
    const n = published.pages;
    assert.equal((await staff.call('PUT', `/api/pr/digests/${published.id}/pages`, new FormData())).status, 403);
    assert.equal((await send(published.id, n - 1)).status, 400, 'a page missing');
    const jpg = await sharp({ create: { width: 1240, height: 1754, channels: 3, background: '#ddd' } }).jpeg().toBuffer();
    assert.equal((await send(published.id, n, { files: [jpg, ...await Promise.all(Array.from({ length: n - 1 }, () => page('#ddd')))] })).status, 400, 'not WebP');
    const story = (await anon.call('GET', `/api/digests/${published.id}`)).body.stories[0];
    const meta = Array.from({ length: n }, (_, i) => ({ body: `หน้าที่ ${i + 1} ค่ายอาสาทดสอบภาพหน้า`, links: [
      { x: 0.1, y: 0.8, w: 0.3, h: 0.05, href: `news.html?id=${story.id}`, label: 'อ่านข่าวเต็ม' },
      { x: 0.1, y: 0.3, w: 0.8, h: 0.05, goto: 3, label: 'สารบัญ' },
      { x: 0.1, y: 0.1, w: 0.2, h: 0.05, href: 'javascript:alert(1)' },
      { x: 2, y: 0.1, w: 0.2, h: 0.05, href: `news.html?id=${story.id}` },
      { x: 0.1, y: 0.1, w: 0.2, h: 0.05, goto: 99 },
    ] }));
    const r = await send(published.id, n, { meta });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const pages = (await anon.call('GET', `/api/digests/${published.id}`)).body.pages;
    assert.equal(pages.length, n);
    assert.deepEqual(pages[0].links.map((l) => l.href || l.goto), [`news.html?id=${story.id}`, 3]);
    assert.match(pages[1].text, /หน้าที่ 2/);
    // Served for good (a new set gets new names); the strip's small copy is 240 px
    const full = await fetch(BASE + pages[0].src);
    assert.equal(full.headers.get('content-type'), 'image/webp');
    assert.match(full.headers.get('cache-control'), /immutable/);
    assert.equal((await sharp(Buffer.from(await (await fetch(BASE + pages[0].thumb)).arrayBuffer())).metadata()).width, 240);
    assert.equal((await fetch(`${BASE}/media/digests/${published.id}/page-00000000-0000-0000-0000-000000000000.webp`)).status, 404);
  });

  test('the text is searched on the shelf (published issues only)', async () => {
    const r = (await anon.call('GET', `/api/digests?q=${encodeURIComponent('ค่ายอาสาทดสอบภาพหน้า')}`)).body;
    const hit = r.results.find((d) => d.id === published.id);
    assert.ok(hit && hit.hits.length === published.pages);
    assert.match(hit.hits[0].snippet, /ค่ายอาสาทดสอบภาพหน้า/);
    assert.equal((await anon.call('GET', `/api/digests?q=${encodeURIComponent('ไม่มีคำนี้ในเล่มแน่นอน')}`)).body.results.length, 0);
    // % and _ are letters here, not patterns
    assert.equal((await anon.call('GET', '/api/digests?q=%25')).body.results.length, 0);
  });

  test('a story in them edited: the pictures are no longer used; more reads change nothing', async () => {
    const story = (await anon.call('GET', `/api/digests/${published.id}`)).body.stories[0];
    await query('update news set views = views + 7 where id = $1', [story.id]);
    assert.ok((await anon.call('GET', `/api/digests/${published.id}`)).body.pages, 'read counts are not printed');
    const { title } = (await query('select title from news where id = $1', [story.id])).rows[0];
    await query('update news set title = $2 where id = $1', [story.id, `${title} (แก้ไข)`]);
    assert.equal((await anon.call('GET', `/api/digests/${published.id}`)).body.pages, null, 'the headline on the page changed');
    assert.equal((await pr.call('GET', `/api/pr/digests/${published.id}`)).body.digest.pagesReady, false);
    await query('update news set title = $2 where id = $1', [story.id, title]);
    assert.ok((await anon.call('GET', `/api/digests/${published.id}`)).body.pages, 'as printed again');
  });

  test('a different layout (the book edited) and the pictures are no longer used', async () => {
    assert.ok((await anon.call('GET', `/api/digests/${published.id}`)).body.pages);
    await pr.call('POST', `/api/pr/digests/${published.id}/unpublish`);
    const s = (await pr.call('GET', `/api/pr/digests/${published.id}`)).body;
    const g = s.groups.find((x) => x.ids.length > 1) || s.groups[0];
    const groups = g.ids.length > 1 ? s.groups.map((x) => (x === g ? { cat: x.cat, ids: x.ids.slice(1) } : x)) : s.groups.slice(1);
    assert.equal((await pr.call('PUT', `/api/pr/digests/${published.id}`, { mode: 'auto', groups })).status, 200);
    const now = (await pr.call('GET', `/api/pr/digests/${published.id}`)).body;
    assert.equal(now.digest.pagesReady, false);
    assert.equal((await pr.call('GET', `/api/digests/${published.id}`)).body.pages, null);
  });
});

describe('the automatic layout', () => {
  test('public stories only, the most read first', async () => {
    const d = (await query('select * from digests where id = $1', [published.id])).rows[0];
    const all = (await query(`select n.id, n.audience from news n where n.withdrawn_at is null and n.published_at <= now()
      and (n.published_at at time zone 'Asia/Bangkok')::date between $1 and $2`, [d.range_start, d.range_end])).rows;
    const stories = await pool(d);
    assert.ok(stories.every((s) => !s.internal));
    assert.equal(stories.length, all.filter((n) => n.audience.includes('public')).length);
    for (let i = 1; i < stories.length; i++) assert.ok(stories[i - 1].views >= stories[i].views, 'most read first');
    const groups = autoGroups(d.kind, stories);
    const first = stories[0];
    if (first) assert.equal(groups[0].cat, first.cat, 'the category of the most read story leads');
  });
});
