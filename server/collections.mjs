// อัลบั้มข่าว (collections, migration 019): the stories of one event or project (news, videos, infographics) on one page
// (collection.html?id=), and on each story's page (news.html: "อยู่ในอัลบั้มข่าว"). The PR team makes them on pr-collections.html.
// - GET    /api/collections?limit=        the sets with at least one live story, newest change first (index.html, collection.html)
//          kinds: { news, video, banner } counts the stories the reader may open; locked: the internal ones they may not
// - GET    /api/collections/:id          the set and its live stories in order; stories the reader may not open are { locked } cards
// - GET    /api/pr/collections            every set, newest change first, with its count and cover
// - POST   /api/pr/collections            { title, description, items: [news id] }
// - PUT    /api/pr/collections/:id        the same fields
// - DELETE /api/pr/collections/:id        the set only; its stories stay
import { Router } from 'express';
import { requirePr } from './auth.mjs';
import { audit } from './audit.mjs';
import { one, query, tx } from './db.mjs';
import { HttpError, str } from './http.mjs';
import { LIVE, cardOut } from './news.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_ITEMS = 100;
export const router = Router();
router.use('/pr/collections', requirePr);

// Live stories of a set, in its order
async function liveItems(ids) {
  if (!ids.length) return [];
  const rows = (await query(`select n.* from news n where ${LIVE} and n.id = any($1)`, [ids])).rows;
  return ids.map((id) => rows.find((n) => n.id === id)).filter(Boolean);
}
// The set's picture: the first story with a cover (or a YouTube thumbnail) the reader may open
const coverOf = (cards) => { const c = cards.find((x) => !x.locked && (x.cover || x.videoThumb)); return c ? { url: c.cover || c.videoThumb, set: c.cover ? c.coverSet : null } : null; };

router.get('/collections', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);
  const rows = (await query('select * from collections where cardinality(items) > 0 order by updated_at desc limit 500')).rows;
  const out = [];
  for (const c of rows) {
    if (out.length >= limit) break;
    const items = (await liveItems(c.items)).map((n) => cardOut(n, req.user));
    if (!items.length) continue;
    const kinds = items.filter((n) => !n.locked).reduce((m, n) => ({ ...m, [n.kind]: (m[n.kind] || 0) + 1 }), {});
    out.push({ id: c.id, title: c.title, description: c.description, updatedAt: c.updated_at, count: items.length, kinds, locked: items.filter((n) => n.locked).length, cover: coverOf(items) });
  }
  res.json({ items: out });
});

router.get('/collections/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบอัลบั้มข่าวนี้');
  const c = await one('select * from collections where id = $1', [req.params.id]);
  if (!c) throw new HttpError(404, 'ไม่พบอัลบั้มข่าวนี้');
  const items = (await liveItems(c.items)).map((n) => cardOut(n, req.user));
  const kinds = items.filter((n) => !n.locked).reduce((m, n) => ({ ...m, [n.kind]: (m[n.kind] || 0) + 1 }), {});
  res.json({ collection: { id: c.id, title: c.title, description: c.description, updatedAt: c.updated_at, count: items.length, kinds, locked: items.filter((n) => n.locked).length, cover: coverOf(items) }, items });
});

// The sets a story is in (news.html) come with the story: setsOf in news.mjs

// ---- PR desk ----
function checkSet(b) {
  const errors = {};
  const title = str(b?.title, 200, 'ชื่ออัลบั้มข่าว');
  const description = str(b?.description, 1000, 'คำอธิบาย');
  const items = Array.isArray(b?.items) ? [...new Set(b.items.filter((x) => typeof x === 'string' && UUID.test(x)))] : [];
  if (!title) errors.title = 'ตั้งชื่ออัลบั้มข่าว';
  if (items.length > MAX_ITEMS) errors.items = `อัลบั้มข่าวมีได้ไม่เกิน ${MAX_ITEMS} ข่าว`;
  if (Object.keys(errors).length) throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', errors);
  return { title, description, items };
}
async function known(items) {
  const found = new Set((await query('select id from news where id = any($1)', [items])).rows.map((r) => r.id));
  if (items.some((id) => !found.has(id))) throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', { items: 'ไม่พบข่าวบางข่าวที่เลือก' });
}
// A set as the desk needs it: every story it lists, withdrawn and scheduled ones too (marked)
async function deskOut(c) {
  const rows = c.items.length ? (await query('select id, title, unit, kind, published_at, withdrawn_at, cover_path from news where id = any($1)', [c.items])).rows : [];
  const items = c.items.map((id) => rows.find((n) => n.id === id)).filter(Boolean).map((n) => ({
    id: n.id, title: n.title, unit: n.unit, kind: n.kind, publishedAt: n.published_at, withdrawn: !!n.withdrawn_at,
    scheduled: n.published_at > new Date(), cover: n.cover_path ? `/media/${n.cover_path}` : null,
  }));
  return { id: c.id, title: c.title, description: c.description, updatedAt: c.updated_at, createdAt: c.created_at, items, url: `collection.html?id=${c.id}` };
}

router.get('/pr/collections', async (req, res) => {
  const rows = (await query('select * from collections order by updated_at desc limit 500')).rows;
  res.json({ items: await Promise.all(rows.map(deskOut)) });
});

router.post('/pr/collections', async (req, res) => {
  const s = checkSet(req.body);
  await known(s.items);
  const c = await tx(async (db) => {
    const row = (await db.query('insert into collections (title, description, items, created_by) values ($1, $2, $3, $4) returning *',
      [s.title, s.description, s.items, req.user.id])).rows[0];
    await audit(db, req.user, 'collection.create', row.id, `สร้างอัลบั้มข่าว "${s.title}" (${s.items.length} ข่าว)`);
    return row;
  });
  res.status(201).json({ collection: await deskOut(c) });
});

router.put('/pr/collections/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบอัลบั้มข่าวนี้');
  const was = await one('select * from collections where id = $1', [req.params.id]);
  if (!was) throw new HttpError(404, 'ไม่พบอัลบั้มข่าวนี้');
  const s = checkSet(req.body);
  await known(s.items);
  const c = await tx(async (db) => {
    const row = (await db.query('update collections set title = $2, description = $3, items = $4, updated_at = now() where id = $1 returning *',
      [was.id, s.title, s.description, s.items])).rows[0];
    await audit(db, req.user, 'collection.update', row.id, `แก้ไขอัลบั้มข่าว "${s.title}" (${s.items.length} ข่าว)`, { before: was.title !== s.title ? was.title : undefined });
    return row;
  });
  res.json({ collection: await deskOut(c) });
});

router.delete('/pr/collections/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบอัลบั้มข่าวนี้');
  await tx(async (db) => {
    const c = (await db.query('delete from collections where id = $1 returning title', [req.params.id])).rows[0];
    if (!c) throw new HttpError(404, 'ไม่พบอัลบั้มข่าวนี้');
    await audit(db, req.user, 'collection.delete', req.params.id, `ลบอัลบั้มข่าว "${c.title}"`);
  });
  res.json({ ok: true });
});
