// อัลบั้มข่าว (collections.mjs): the PR team makes a set of stories; collection.html shows it, news.html shows the set a story is in.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { restore, snapshot } from './cleanup.mjs';
import { anon, form, img, login } from './helpers.mjs';

let snap, pr, staff, ids = [], setId;
const day = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(Date.now() - n * 86400000));

before(async () => {
  snap = await snapshot();
  [pr, staff] = await Promise.all([login('pr'), login('staff')]);
  const pic = await img('#468', 400, 300);
  const make = async (d) => {
    const r = await pr.call('POST', '/api/pr/import', form({ unit: 'กองกลาง', categories: ['ข่าวการศึกษา'], audience: ['public'], body: 'ข้อความประกอบทดสอบ', credit: 'ทีมกราฟิกทดสอบ', ...d },
      d.kind === 'video' ? {} : { photo: [['a.jpg', pic, 'image/jpeg']] }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.news.id;
  };
  ids = [
    await make({ kind: 'news', credit: 'งานประชาสัมพันธ์ทดสอบ', title: 'ชุดทดสอบ ข่าวพิธีเปิด', body: 'ก'.repeat(40), date: day(3) }),
    await make({ kind: 'video', title: 'ชุดทดสอบ วิดีโอบรรยากาศ', date: day(3), videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
    await make({ kind: 'banner', categories: ['ข่าวการศึกษา'], title: 'ชุดทดสอบ อินโฟกราฟิกสรุปงาน', date: day(2) }),
    await make({ kind: 'news', credit: 'งานประชาสัมพันธ์ทดสอบ', title: 'ชุดทดสอบ ข่าวภายใน', body: 'ก'.repeat(40), date: day(2), audience: ['staff'] }),
  ];
});
after(async () => { await restore(snap); });

describe('อัลบั้มข่าว', () => {
  test('PR only; a name is needed; only known stories', async () => {
    assert.equal((await staff.call('POST', '/api/pr/collections', { title: 'x', items: [] })).status, 403);
    assert.equal((await anon.call('GET', '/api/pr/collections')).status, 401);
    const noName = await pr.call('POST', '/api/pr/collections', { title: '  ', items: ids });
    assert.equal(noName.status, 400);
    assert.ok(noName.body.details.title);
    const bad = await pr.call('POST', '/api/pr/collections', { title: 'ชุด', items: ['00000000-0000-4000-8000-000000000000'] });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.details.items);
  });

  test('made in the order given, the same story once', async () => {
    const r = await pr.call('POST', '/api/pr/collections', { title: 'งานทดสอบอัลบั้มข่าว 2569', description: 'รวมทุกชิ้นงานของงานทดสอบ', items: [ids[2], ids[0], ids[1], ids[0], ids[3]] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    setId = r.body.collection.id;
    assert.deepEqual(r.body.collection.items.map((n) => n.id), [ids[2], ids[0], ids[1], ids[3]]);
    assert.ok((await pr.call('GET', '/api/pr/collections')).body.items.some((c) => c.id === setId));
  });

  test('the page: live stories in order; internal ones locked for readers outside the group', async () => {
    const r = await anon.call('GET', `/api/collections/${setId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.collection.title, 'งานทดสอบอัลบั้มข่าว 2569');
    assert.deepEqual(r.body.items.map((n) => n.id), [ids[2], ids[0], ids[1], ids[3]]);
    assert.ok(r.body.items[3].locked && !r.body.items[3].title, 'internal story: a locked card');
    assert.deepEqual(r.body.collection.kinds, { banner: 1, news: 1, video: 1 });
    assert.ok(r.body.collection.cover?.url, 'cover from the first story with a picture');
    const mine = (await staff.call('GET', `/api/collections/${setId}`)).body.items[3];
    assert.equal(mine.title, 'ชุดทดสอบ ข่าวภายใน', 'staff read it');
    assert.equal((await anon.call('GET', '/api/collections/not-an-id')).status, 404);
    // The list readers see (index.html, collection.html): this set, with its count; an empty set is left out
    const list = (await anon.call('GET', '/api/collections')).body.items;
    assert.equal(list.find((c) => c.id === setId)?.count, 4);
    const empty = (await pr.call('POST', '/api/pr/collections', { title: 'ชุดว่าง', items: [] })).body.collection.id;
    assert.ok(!(await anon.call('GET', '/api/collections')).body.items.some((c) => c.id === empty), 'empty set not listed');
  });

  test('a story shows its set with the others; a withdrawn story leaves the page but stays in the set', async () => {
    const s = (await anon.call('GET', `/api/news/${ids[0]}`)).body;
    assert.equal(s.sets.length, 1);
    assert.equal(s.sets[0].id, setId);
    assert.equal(s.sets[0].count, 4);
    assert.ok(!s.sets[0].others.some((n) => n.id === ids[0]), 'not itself');
    assert.ok(!s.related.some((r) => s.sets[0].others.some((o) => o.id === r.id)), 'อ่านข่าวไหนต่อดี? does not repeat the set');
    const html = String((await anon.call('GET', `/news.html?id=${ids[0]}`)).body);
    assert.ok(html.includes(setId), 'in the page the server sends');

    await pr.call('POST', `/api/pr/news/${ids[1]}/withdraw`, { reason: 'ทดสอบ' });
    assert.deepEqual((await anon.call('GET', `/api/collections/${setId}`)).body.items.map((n) => n.id), [ids[2], ids[0], ids[3]]);
    const desk = (await pr.call('GET', '/api/pr/collections')).body.items.find((c) => c.id === setId);
    assert.ok(desk.items.find((n) => n.id === ids[1]).withdrawn, 'the desk still lists it, marked');
    await pr.call('POST', `/api/pr/news/${ids[1]}/restore`);
  });

  test('edited, then deleted (its stories stay)', async () => {
    const e = await pr.call('PUT', `/api/pr/collections/${setId}`, { title: 'ชื่อใหม่ของชุด', description: '', items: [ids[1]] });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.equal((await anon.call('GET', `/api/collections/${setId}`)).body.collection.title, 'ชื่อใหม่ของชุด');
    assert.deepEqual((await anon.call('GET', `/api/news/${ids[0]}`)).body.sets, [], 'left the set');
    assert.equal((await pr.call('DELETE', `/api/pr/collections/${setId}`)).status, 200);
    assert.equal((await anon.call('GET', `/api/collections/${setId}`)).status, 404);
    assert.equal((await anon.call('GET', `/api/news/${ids[1]}`)).status, 200, 'the story is still there');
  });
});

describe('the story page: อัลบั้มข่าว preview', () => {
  test('only stories the reader may open; the count is still the whole album', async () => {
    const r = await pr.call('POST', '/api/pr/collections', { title: 'อัลบั้มที่มีข่าวภายใน', items: [ids[0], ids[3], ids[2]] });
    const s = (await anon.call('GET', `/api/news/${ids[0]}`)).body.sets.find((c) => c.id === r.body.collection.id);
    assert.equal(s.count, 3);
    assert.deepEqual(s.others.map((n) => n.id), [ids[2]], 'the internal one is left out for a reader outside its group');
    assert.ok(s.others.every((n) => !n.locked));
    const mine = (await staff.call('GET', `/api/news/${ids[0]}`)).body.sets.find((c) => c.id === r.body.collection.id);
    assert.deepEqual(mine.others.map((n) => n.id), [ids[3], ids[2]], 'staff see it');
  });
});

describe('แจ้งเตือนงานใหม่ (/api/pr/arrivals)', () => {
  test('work sent after the time asked from, newest first; PR only', async () => {
    assert.equal((await staff.call('GET', '/api/pr/arrivals')).status, 403);
    const first = (await pr.call('GET', '/api/pr/arrivals')).body;
    assert.deepEqual(first.items, [], 'no time given: nothing, only the time to ask from');
    await staff.call('PUT', '/api/me/profile', { firstName: 'สมชาย', lastName: 'ใจดี', phone: '1234', unit: 'สำนักงานอธิการบดี', subUnit: 'กองกลาง', position: 'นักประชาสัมพันธ์', consent: true });
    const v = await staff.call('POST', '/api/submissions', form({ type: 'video', desc: 'คำอธิบายวิดีโอทดสอบ', title: 'วิดีโอแจ้งเตือนทดสอบ', eventDate: '2026-10-12', unit: 'กองกลาง', categories: ['ข่าวการศึกษา'],
      videoLink: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', videoPlatform: 'youtube', audience: ['public'], consent: true }));
    assert.equal(v.status, 201, JSON.stringify(v.body));
    const next = (await pr.call('GET', `/api/pr/arrivals?since=${encodeURIComponent(first.now)}`)).body;
    assert.equal(next.items[0]?.ref, v.body.submission.ref);
    assert.equal(next.items[0].again, false);
    assert.equal(next.items[0].sender, 'สมชาย ใจดี');
    const later = (await pr.call('GET', `/api/pr/arrivals?since=${encodeURIComponent(next.now)}`)).body;
    assert.ok(!later.items.some((x) => x.ref === v.body.submission.ref), 'not twice');
  });
});

describe('ข่าวในอัลบั้มเดียวกันเป็นข่าวที่เกี่ยวข้องอัตโนมัติ', () => {
  test('after the PR team\'s picks, in album order; out of the album, out of ข่าวที่เกี่ยวข้อง', async () => {
    const a = (await pr.call('POST', '/api/pr/collections', { title: 'อัลบั้มสำหรับข่าวที่เกี่ยวข้อง', items: [ids[0], ids[1], ids[2]] })).body.collection.id;
    await pr.call('PUT', `/api/pr/news/${ids[0]}/related`, { ids: [ids[2]] });
    const s = (await anon.call('GET', `/api/news/${ids[0]}`)).body;
    assert.deepEqual(s.linked.map((n) => n.id), [ids[2], ids[1]], 'the pick first, then the album story not already picked');
    assert.equal(s.linkedFromAlbum, 1);
    assert.ok(!s.related.some((r) => [ids[1], ids[2]].includes(r.id)), 'อ่านข่าวไหนต่อดี? does not repeat them');
    // The other story of the album has this one as related too, without anyone picking it
    assert.ok((await anon.call('GET', `/api/news/${ids[1]}`)).body.linked.some((n) => n.id === ids[0]));
    // The desk knows the album
    const row = (await pr.call('GET', '/api/pr/news?show=all&limit=100')).body.items.find((n) => n.id === ids[0]);
    assert.ok(row.albums.some((x) => x.id === a && x.count === 2));
    await pr.call('PUT', `/api/pr/collections/${a}`, { title: 'อัลบั้มสำหรับข่าวที่เกี่ยวข้อง', items: [ids[0], ids[2]] });
    assert.deepEqual((await anon.call('GET', `/api/news/${ids[0]}`)).body.linked.map((n) => n.id), [ids[2]], 'taken out of the album: no longer related');
    await pr.call('PUT', `/api/pr/news/${ids[0]}/related`, { ids: [] });
  });
});
