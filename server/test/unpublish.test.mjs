// ยกเลิกการเผยแพร่: the story leaves the site, the work goes back to รอตรวจ; เผยแพร่อีกครั้ง updates the same story (same
// link, reads kept). ข่าวที่เกี่ยวข้อง: PR's picks on the story, in order, only live ones the reader may open.
// Banners keep คำโปรย.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { query } from '../db.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { ID_STAFF, anon, form, img, login } from './helpers.mjs';

let snap, staff, pr, ref, newsId;
const NEWS = { type: 'news', credit: 'งานประชาสัมพันธ์ทดสอบ', title: 'ข่าวทดสอบยกเลิกการเผยแพร่', lead: 'คำโปรยเดิม', eventDate: '2026-10-10', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
  contentMode: 'own', body: 'ก'.repeat(160), audience: ['public'], consent: true };
const publish = (r, extra = {}) => pr.call('POST', `/api/pr/submissions/${r}/publish`, { title: NEWS.title, body: 'ข'.repeat(80), categories: NEWS.categories, audience: ['public'], ...extra });

before(async () => {
  snap = await snapshot();
  [staff, pr] = await Promise.all([login('staff'), login('pr')]);
  await staff.call('PUT', '/api/me/profile', { ...ID_STAFF, unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'นักประชาสัมพันธ์', consent: true });
  const photos = [['a.jpg', await img('#468', 800, 600), 'image/jpeg'], ['b.jpg', await img('#864', 800, 600), 'image/jpeg']];
  const s = await staff.call('POST', '/api/submissions', form(NEWS, { photo: photos }));
  assert.equal(s.status, 201, JSON.stringify(s.body));
  ref = s.body.submission.ref;
  const p = await publish(ref);
  assert.equal(p.status, 201, JSON.stringify(p.body));
  newsId = p.body.news.id;
});
after(async () => { await restore(snap); });

describe('ยกเลิกการเผยแพร่', () => {
  test('off the site, back to รอตรวจ, no email; only published work', async () => {
    await query("update news set views = 7 where id = $1", [newsId]);
    const before = (await query("select count(*)::int n from email_outbox where ref = $1 and kind = 'submission.status'", [ref])).rows[0].n;
    const r = await pr.call('POST', `/api/pr/submissions/${ref}/unpublish`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.submission.status, 'review');
    assert.equal((await anon.call('GET', `/api/news/${newsId}`)).status, 410);
    assert.equal((await query("select count(*)::int n from email_outbox where ref = $1 and kind = 'submission.status'", [ref])).rows[0].n, before);
    assert.equal((await pr.call('POST', `/api/pr/submissions/${ref}/unpublish`)).status, 409, 'not twice');
    const sender = (await staff.call('GET', `/api/submissions/${ref}`)).body.submission;
    assert.equal(sender.status, 'review');
    assert.ok(sender.history.some((h) => h.status === 'unpublished'));
    assert.equal((await staff.call('POST', `/api/pr/submissions/${ref}/unpublish`)).status, 403, 'PR only');
  });
  test('เผยแพร่อีกครั้ง: the same story, new text, reads kept, old pictures it no longer uses removed', async () => {
    const files = (await pr.call('GET', `/api/submissions/${ref}`)).body.submission.files;
    const old = (await query('select cover_path, gallery from news where id = $1', [newsId])).rows[0];
    const p = await publish(ref, { title: 'หัวข้อใหม่หลังแก้ไข', cover: files[1].id, gallery: [] });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.equal(p.body.news.id, newsId, 'same story');
    assert.equal((await query('select count(*)::int n from news where submission_id = (select id from submissions where ref = $1)', [ref])).rows[0].n, 1);
    const story = (await anon.call('GET', `/api/news/${newsId}`)).body.story;
    assert.equal(story.title, 'หัวข้อใหม่หลังแก้ไข');
    assert.equal(story.views, 7);
    assert.equal(story.gallery.length, 0);
    const { existsSync } = await import('node:fs');
    const { abs } = await import('../files.mjs');
    assert.ok(!existsSync(abs(`media/${old.cover_path}`)), 'the old cover file is gone');
    assert.ok(existsSync(abs(`media/${newsId}/${files[1].id}.webp`)));
  });
  test('restoring an unpublished story on pr-news publishes its work again', async () => {
    await pr.call('POST', `/api/pr/submissions/${ref}/unpublish`);
    assert.equal((await pr.call('POST', `/api/pr/news/${newsId}/restore`)).status, 200);
    assert.equal((await pr.call('GET', `/api/submissions/${ref}`)).body.submission.status, 'published');
    const row = (await pr.call('GET', `/api/pr/news?q=${encodeURIComponent('หัวข้อใหม่หลังแก้ไข')}`)).body.items.find((n) => n.id === newsId);
    assert.equal(row.submissionStatus, 'published');
  });
});

describe('ข่าวที่เกี่ยวข้อง', () => {
  test('PR sets them; the story shows them in order and leaves them out of ข่าวใกล้เคียง', async () => {
    const others = (await query("select id from news where withdrawn_at is null and published_at <= now() and 'public' = any(audience) and id <> $1 order by published_at desc limit 2", [newsId])).rows.map((r) => r.id);
    assert.equal(others.length, 2);
    assert.equal((await staff.call('PUT', `/api/pr/news/${newsId}/related`, { ids: others })).status, 403);
    assert.equal((await pr.call('PUT', `/api/pr/news/${newsId}/related`, { ids: [newsId] })).status, 400, 'not itself');
    assert.equal((await pr.call('PUT', `/api/pr/news/${newsId}/related`, { ids: Array(7).fill(0).map((_, i) => `00000000-0000-4000-8000-00000000000${i}`) })).status, 400, 'at most 6');
    const r = await pr.call('PUT', `/api/pr/news/${newsId}/related`, { ids: [others[1], others[0]] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const got = (await anon.call('GET', `/api/news/${newsId}`)).body;
    assert.deepEqual(got.linked.map((n) => n.id), [others[1], others[0]]);
    assert.ok(!got.related.some((n) => others.includes(n.id)), 'not again under ข่าวใกล้เคียง');
    const row = (await pr.call('GET', `/api/pr/news?q=${encodeURIComponent('หัวข้อใหม่หลังแก้ไข')}`)).body.items.find((n) => n.id === newsId);
    assert.deepEqual(row.related.map((x) => x.id), [others[1], others[0]]);
    // The page has them before the browser runs anything
    const html = String((await anon.call('GET', `/news.html?id=${newsId}`)).body);
    assert.match(html, /"linked":\[\{/);
    assert.equal((await pr.call('PUT', `/api/pr/news/${newsId}/related`, { ids: [] })).status, 200);
    assert.deepEqual((await anon.call('GET', `/api/news/${newsId}`)).body.linked, []);
  });
});

describe('banner คำโปรย', () => {
  test('kept on banners and in drafts', async () => {
    const art = [['art.jpg', await img('#fa0', 800, 600), 'image/jpeg']];
    const s = await staff.call('POST', '/api/submissions', form({ type: 'banner', designer: 'ทีมกราฟิกทดสอบ', title: 'แบนเนอร์มีคำโปรย', lead: 'คำโปรยแบนเนอร์', desc: 'ข้อความ', unit: 'กองกลาง', audience: ['public'], consent: true }, { art }));
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal((await pr.call('GET', `/api/submissions/${s.body.submission.ref}`)).body.submission.fields.lead, 'คำโปรยแบนเนอร์');
    const d = await staff.call('POST', '/api/drafts', form({ type: 'banner', title: 'ร่าง', lead: 'โปรยในร่าง' }));
    assert.equal((await staff.call('GET', `/api/drafts/${d.body.draft.id}`)).body.draft.data.lead, 'โปรยในร่าง');
  });
});
