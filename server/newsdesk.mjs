// PR desk for published stories and imports (pr-news.html, pr-import.html). Role pr or admin; /pr/import also intern
// (นักศึกษาฝึกงาน สสอ.), who imports past stories and has no other part of the desk.
// - GET  /api/pr/news?q=&show=all|live|imported|withdrawn|scheduled&unit=&limit=&offset=
// - POST /api/pr/news/:id/feature   { featured }
// - POST /api/pr/news/:id/withdraw  { reason }      the story page answers 410 with the reason
// - POST /api/pr/news/:id/restore                  (a story taken back with ยกเลิกการเผยแพร่: its work is published again)
// - PUT  /api/pr/news/:id/related   { ids }         ข่าวที่เกี่ยวข้อง, up to MAX_RELATED, in this order
// - GET  /api/pr/news/:id/revisions   every version of the story, newest first (news_revisions, migration 010)
// - GET  /api/pr/news/:id            the story as the editor needs it (pr-import.html?edit=id)
// - PUT  /api/pr/news/:id            multipart: data (JSON, as for import, + photos: ['p:<kept path>' | 'u:<n-th upload>'] in order) + photo files
// - DELETE /api/pr/news/:id          ลบข่าว: only a withdrawn story; gone for good with its pictures, reads and history.
//        Its work (if any) moves to ลบแล้ว on pr.html unless it is back in the queue (ยกเลิกการเผยแพร่)
// - POST /api/pr/import/fetch       { url }         reads a public Facebook post: text, photos, date (best effort)
// - GET  /api/pr/import/check?url=&unit=&date=&title=   stories that may be the same one
// - POST /api/pr/import             multipart: data (JSON) + photo files; data.remoteImages = photo URLs from /fetch;
//        data.photoOrder = ['r:<n>' | 'u:<n>'] the pictures in the order arranged (default: Facebook ones first)
//        Imported stories go live at once with their original date, skip the queue and the inbox,
//        and take their place by date in every list, the home page too.
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { requireImport, requirePr } from './auth.mjs';
import { audit } from './audit.mjs';
import { one, query, tx } from './db.mjs';
import { abs, acceptUpload, publishFile, removeMedia, removeTemp, tempPath } from './files.mjs';
import { HttpError, str } from './http.mjs';
import { LOCAL_DAY } from './news.mjs';
import { allUnits } from './org.mjs';
import { AUDIENCES, MAX_CATS, PLATFORMS, SOLO_MSG, TYPES, albumUrl, audienceLabel, bodyLeading, bodySize, categories, soloOk, videoLinks } from './rules.mjs';
import { get } from './settings.mjs';
import { limit } from './security.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MB = 1024 * 1024;
export const router = Router();
router.use('/pr/news', requirePr);
router.use('/pr/import', requireImport);

// ---- Published stories ----
const SHOW = {
  live: 'n.withdrawn_at is null and n.published_at <= now()',
  imported: 'n.imported and n.withdrawn_at is null',
  withdrawn: 'n.withdrawn_at is not null',
  scheduled: 'n.withdrawn_at is null and n.published_at > now()',
};

router.get('/pr/news', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const base = [];
  const q = str(req.query.q, 100, 'คำค้น');
  if (q) base.push(`(n.title ilike ${p(`%${q.replace(/[\\%_]/g, '\\$&')}%`)} or n.unit ilike $${params.length})`);
  if (req.query.unit) base.push(`n.unit = ${p(String(req.query.unit))}`);
  const counts = (await query(`select ${Object.entries(SHOW).map(([k, w]) => `count(*) filter (where ${w})::int ${k}`).join(', ')}, count(*)::int "all"
    from news n ${base.length ? `where ${base.join(' and ')}` : ''}`, params)).rows[0];
  const where = [...base];
  if (SHOW[req.query.show]) where.push(SHOW[req.query.show]);
  const rows = (await query(
    `select n.*, s.ref, s.status submission_status, u.name creator_name, w.name withdrawn_by_name, count(*) over ()::int total
     from news n left join submissions s on s.id = n.submission_id left join users u on u.id = n.created_by left join users w on w.id = n.withdrawn_by
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by n.published_at desc, n.id limit ${limit} offset ${offset}`, params)).rows;
  // Titles of each story's ข่าวที่เกี่ยวข้อง, in their order
  const ids = [...new Set(rows.flatMap((n) => n.related))];
  const named = ids.length ? new Map((await query('select id, title, withdrawn_at from news where id = any($1)', [ids])).rows.map((r) => [r.id, r])) : new Map();
  const titles = new Map(rows.map((n) => [n.id, n.related.map((id) => named.get(id)).filter(Boolean).map((r) => ({ id: r.id, title: r.title, withdrawn: !!r.withdrawn_at }))]));
  // อัลบั้มข่าว each story is in: their other stories are ข่าวที่เกี่ยวข้อง on their own (news.mjs)
  const albums = rows.length ? (await query('select id, title, items from collections where items && $1::uuid[]', [rows.map((n) => n.id)])).rows : [];
  res.json({
    counts, total: SHOW[req.query.show] ? counts[req.query.show] : counts.all,
    items: rows.map((n) => ({
      id: n.id, title: n.title, unit: n.unit, kind: n.kind, categories: n.categories, audience: audienceLabel(n.audience),
      cover: n.cover_path ? `/media/${n.cover_path}` : null, photos: (n.cover_path ? 1 : 0) + n.gallery.length,
      publishedAt: n.published_at, scheduled: n.published_at > new Date(), featured: n.featured, views: n.views,
      imported: n.imported, sourceUrl: n.source_url, albumUrl: n.album_url, ref: n.ref, createdBy: n.creator_name,
      withdrawn: n.withdrawn_at ? { at: n.withdrawn_at, reason: n.withdrawn_reason, by: n.withdrawn_by_name } : null,
      submissionStatus: n.submission_status || null,
      related: (titles.get(n.id) || []),
      albums: albums.filter((c) => c.items.includes(n.id)).map((c) => ({ id: c.id, title: c.title, count: c.items.length - 1 })),
    })),
  });
});

// Edit history: who changed what and when. Long texts are sent whole; the page shows what changed.
router.get('/pr/news/:id/revisions', async (req, res) => {
  const n = await story(req.params.id);
  const rows = (await query(
    `select r.id, r.at, r.action, r.changes, r.actor_email, coalesce(nullif(r.actor_name, ''), u.name) actor_name
     from news_revisions r left join users u on u.id = r.actor_id
     where r.news_id = $1 order by r.at desc, r.id desc limit 200`, [n.id])).rows;
  res.json({
    story: { id: n.id, title: n.title },
    items: rows.map((r) => ({
      id: Number(r.id), at: r.at, action: r.action, actor: r.actor_email ? { name: r.actor_name || '', email: r.actor_email } : null,
      changes: Object.entries(r.changes).map(([field, { from, to }]) => ({ field, from, to })),
    })),
  });
});

async function story(id) {
  if (!UUID.test(id)) throw new HttpError(404, 'ไม่พบข่าวนี้');
  const n = await one('select * from news where id = $1', [id]);
  if (!n) throw new HttpError(404, 'ไม่พบข่าวนี้');
  return n;
}

router.get('/pr/news/:id', async (req, res) => {
  const n = await story(req.params.id);
  const s = n.submission_id ? await one('select ref, status from submissions where id = $1', [n.submission_id]) : null;
  res.json({
    story: {
      id: n.id, kind: n.kind, title: n.title, titleEn: n.title_en, lead: n.lead, body: n.body, bodyEn: n.body_en, bodySize: n.body_size, bodyLeading: n.body_leading,
      unit: n.unit, categories: n.categories, audience: n.audience, videoUrl: n.video_url, videoLinks: n.video_links, credit: n.credit, place: n.place,
      sourceUrl: n.source_url, albumUrl: n.album_url, imported: n.imported, publishedAt: n.published_at, withdrawn: !!n.withdrawn_at,
      ref: s?.ref || null, submissionStatus: s?.status || null,
      photos: [n.cover_path, ...n.gallery].filter(Boolean).map((p) => ({ path: p, url: `/media/${p}` })),
    },
  });
});

// แก้ไขข่าว (pr-import.html?edit=id): the story's text, settings and pictures. Pictures it no longer uses are removed.
router.put('/pr/news/:id', limit('import', { max: 120, windowMs: 10 * 60 * 1000 }), acceptUpload, async (req, res) => {
  const added = [];
  try {
    const n = await story(req.params.id);
    const d = req.data;
    const uploads = req.uploads.filter((f) => f.kind === 'photo');
    if (req.uploads.some((f) => f.kind !== 'photo')) throw new HttpError(400, 'แนบได้เฉพาะไฟล์ภาพ');
    const had = [n.cover_path, ...n.gallery].filter(Boolean);
    const tokens = (Array.isArray(d?.photos) ? d.photos : []).filter((t) => typeof t === 'string');
    const order = [...new Set(tokens)].filter((t) => (t.startsWith('p:') && had.includes(t.slice(2))) || (/^u:\d+$/.test(t) && Number(t.slice(2)) < uploads.length));
    const max = get('photos').max;
    if (order.length > max) throw new HttpError(400, `แนบภาพได้ไม่เกิน ${max} ภาพ`);
    const row = checkImport(d, order.length, { imported: n.imported });
    const paths = [];
    for (const t of order) {
      if (t.startsWith('p:')) { paths.push(t.slice(2)); continue; }
      const f = uploads[Number(t.slice(2))];
      paths.push(await publishFile(n.id, f.path, f.originalname));
      added.push(paths.at(-1));
    }
    await tx(async (c) => {
      await c.query(
        `update news set kind = $2, title = $3, lead = $4, body = $5, unit = $6, categories = $7, audience = $8, cover_path = $9, gallery = $10,
           video_url = $11, credit = $12, place = $13, album_url = $14, source_url = $15, published_at = $16, body_size = $17, body_leading = $18,
           event_date = case when imported then $19::date else event_date end,
           title_en = case when $20 then $21 else title_en end, body_en = case when $20 then $22 else body_en end, video_links = $23
         where id = $1`,
        [n.id, row.kind, row.title, row.lead, row.body, row.unit, row.categories, row.audience, paths[0] || null, paths.slice(1),
          row.video_url, row.credit, row.place, row.album_url, row.source_url ?? n.source_url, row.published_at, row.body_size, row.body_leading,
          row.date, d.titleEn !== undefined || d.bodyEn !== undefined, row.title_en, row.body_en, row.video_links]);
      await audit(c, req.user, 'news.update', n.id, `แก้ไขข่าว "${row.title}"`, { before: n.title !== row.title ? n.title : undefined });
    }, req.user);
    await Promise.all(had.filter((p) => !paths.includes(p)).map(removeMedia));
    res.json({ news: { id: n.id, title: row.title, url: `news.html?id=${n.id}` } });
  } catch (err) {
    await Promise.all(added.map(removeMedia));
    throw err;
  } finally {
    await removeTemp(req.uploads || []);
  }
});

router.delete('/pr/news/:id', async (req, res) => {
  const n = await story(req.params.id);
  if (!n.withdrawn_at) throw new HttpError(409, 'ถอนข่าวก่อน จึงจะลบได้');
  await tx(async (c) => {
    // Work that was published as this story goes to ลบแล้ว (quietly, as ลบข่าว on pr.html); work back in the queue stays there
    const work = n.submission_id && (await c.query("update submissions set status = 'rejected', pr_unread = false where id = $1 and status = 'published' returning id", [n.submission_id])).rows[0];
    if (work) await c.query("insert into submission_events (submission_id, status, actor_id) values ($1, 'rejected', $2)", [work.id, req.user.id]);
    await c.query('update news set related = array_remove(related, $1) where $1 = any(related)', [n.id]);
    await c.query('delete from news where id = $1', [n.id]);
    await audit(c, req.user, 'news.delete', n.id, `ลบข่าว "${n.title}"`, { unit: n.unit, publishedAt: n.published_at, withdrawnReason: n.withdrawn_reason });
  }, req.user);
  await rm(abs(join('media', n.id)), { recursive: true, force: true });
  res.json({ ok: true });
});

router.post('/pr/news/:id/feature', async (req, res) => {
  const n = await story(req.params.id);
  const featured = req.body?.featured === true;
  await tx(async (c) => {
    await c.query('update news set featured = $2 where id = $1', [n.id, featured]);
    await audit(c, req.user, 'news.feature', n.id, `${featured ? 'ตั้งเป็นข่าวเด่น' : 'เลิกเป็นข่าวเด่น'}: "${n.title}"`, { featured });
  }, req.user);
  res.json({ ok: true, featured });
});

// "ดูรูปภาพเพิ่มเติม" link; empty removes it
router.put('/pr/news/:id/album', async (req, res) => {
  const n = await story(req.params.id);
  const url = albumUrl(req.body?.albumUrl);
  if (url === n.album_url) return res.json({ ok: true, albumUrl: url });
  await tx(async (c) => {
    await c.query('update news set album_url = $2 where id = $1', [n.id, url]);
    await audit(c, req.user, 'news.update', n.id, `${url ? 'ตั้งลิงก์ภาพเพิ่มเติม' : 'ลบลิงก์ภาพเพิ่มเติม'}: "${n.title}"`, { albumUrl: url, before: n.album_url });
  }, req.user);
  res.json({ ok: true, albumUrl: url });
});

export const MAX_RELATED = 6;
router.put('/pr/news/:id/related', async (req, res) => {
  const n = await story(req.params.id);
  const want = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.filter((x) => typeof x === 'string' && UUID.test(x)))] : null;
  if (!want) throw new HttpError(400, 'ส่งรายการข่าวที่เกี่ยวข้องมาไม่ถูกต้อง');
  if (want.includes(n.id)) throw new HttpError(400, 'เลือกข่าวนี้เป็นข่าวที่เกี่ยวข้องกับตัวเองไม่ได้');
  if (want.length > MAX_RELATED) throw new HttpError(400, `เลือกข่าวที่เกี่ยวข้องได้ไม่เกิน ${MAX_RELATED} ข่าว`);
  const found = new Set((await query('select id from news where id = any($1)', [want])).rows.map((r) => r.id));
  if (want.some((id) => !found.has(id))) throw new HttpError(400, 'ไม่พบข่าวบางข่าวที่เลือก');
  await tx(async (c) => {
    await c.query('update news set related = $2 where id = $1', [n.id, want]);
    await audit(c, req.user, 'news.related', n.id, `ข่าวที่เกี่ยวข้องของ "${n.title}": ${want.length} ข่าว`, { ids: want, before: n.related });
  }, req.user);
  res.json({ ok: true, ids: want });
});

router.post('/pr/news/:id/withdraw', async (req, res) => {
  const n = await story(req.params.id);
  const reason = str(req.body?.reason, 300, 'เหตุผล');
  if (!reason) throw new HttpError(400, 'บอกเหตุผลที่ถอนข่าว ผู้อ่านจะเห็นข้อความนี้');
  if (n.withdrawn_at) throw new HttpError(409, 'ข่าวนี้ถูกถอนแล้ว');
  await tx(async (c) => {
    await c.query('update news set withdrawn_at = now(), withdrawn_reason = $2, withdrawn_by = $3, featured = false where id = $1', [n.id, reason, req.user.id]);
    await audit(c, req.user, 'news.withdraw', n.id, `ถอนข่าว "${n.title}"`, { reason });
  }, req.user);
  res.json({ ok: true });
});

router.post('/pr/news/:id/restore', async (req, res) => {
  const n = await story(req.params.id);
  if (!n.withdrawn_at) throw new HttpError(409, 'ข่าวนี้ยังเผยแพร่อยู่');
  await tx(async (c) => {
    await c.query('update news set withdrawn_at = null, withdrawn_reason = null, withdrawn_by = null where id = $1', [n.id]);
    const back = n.submission_id && (await c.query("update submissions set status = 'published' where id = $1 and status <> 'published' returning id", [n.submission_id])).rows[0];
    if (back) await c.query("insert into submission_events (submission_id, status, actor_id) values ($1, 'published', $2)", [back.id, req.user.id]);
    await audit(c, req.user, 'news.restore', n.id, `คืนข่าว "${n.title}"`);
  }, req.user);
  res.json({ ok: true });
});

// ---- Facebook ----
const FB_HOST = /^(www\.|m\.|web\.|mbasic\.)?(facebook\.com|fb\.com|fb\.watch)$/i;
const FB_IMAGE_HOST = /(^|\.)(fbcdn\.net|fbsbx\.com)$/i;
const FB_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

export function fbUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!FB_HOST.test(u.hostname)) return null;
  u.protocol = 'https:';
  if (/^(m|web|mbasic)\./i.test(u.hostname)) u.hostname = 'www.' + u.hostname.replace(/^(m|web|mbasic)\./i, '');
  // Keep only what identifies the post
  const keep = ['story_fbid', 'fbid', 'id', 'v'];
  for (const k of [...u.searchParams.keys()]) if (!keep.includes(k)) u.searchParams.delete(k);
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

const decode = (s) => s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|#39);/gi, (m, e) => {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }[e.toLowerCase()];
  if (named) return named;
  const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isFinite(code) ? String.fromCodePoint(code) : m;
});

// Reads the Open Graph tags (and a publish time if the page has one) from a post's HTML
export function parsePost(html) {
  const metas = [...html.matchAll(/<meta\s+[^>]*>/gi)].map((m) => m[0]);
  const attr = (tag, name) => tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'))?.[1];
  const values = (prop) => metas.filter((t) => (attr(t, 'property') || attr(t, 'name') || '').toLowerCase() === prop).map((t) => decode(attr(t, 'content') || '')).filter(Boolean);
  const text = (values('og:description')[0] || values('description')[0] || '').trim();
  const images = [...new Set(values('og:image').concat(values('og:image:url')).concat(values('og:image:secure_url')))];
  let time = values('article:published_time')[0] || values('og:updated_time')[0];
  if (!time) {
    const unix = html.match(/"(?:publish_time|creation_time)"\s*:\s*(\d{10})/)?.[1] || html.match(/data-utime="(\d{10})"/)?.[1];
    if (unix) time = new Date(Number(unix) * 1000).toISOString();
  }
  const date = time && !Number.isNaN(Date.parse(time))
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(time)) : null;
  return {
    pageName: values('og:title')[0] || null,
    text,
    truncated: /(\.\.\.|…)$/.test(text),
    images,
    date,
    url: values('og:url')[0] || null,
  };
}

// fetch that follows redirects only within Facebook
async function fbFetch(url) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': FB_UA, 'Accept-Language': 'th,en;q=0.8' }, signal: AbortSignal.timeout(12000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), current);
      if (!FB_HOST.test(next.hostname)) throw new HttpError(422, 'ลิงก์นี้พาไปนอก Facebook ระบบจึงไม่ดึงข้อมูลให้');
      current = next.toString();
      continue;
    }
    if (!res.ok) throw new HttpError(422, `Facebook ไม่เปิดโพสต์นี้ให้ระบบอ่าน (รหัส ${res.status}) ตรวจว่าโพสต์เป็นสาธารณะ หรือกรอกเอง`);
    const reader = res.body.getReader();
    let html = '';
    const dec = new TextDecoder();
    while (html.length < 2 * MB) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    return html;
  }
  throw new HttpError(422, 'ลิงก์เปลี่ยนเส้นทางหลายครั้งเกินไป');
}

// Each fetch is a request to Facebook from our server
router.post('/pr/import/fetch', limit('fbFetch', { max: 60, windowMs: 10 * 60 * 1000 }), async (req, res) => {
  const url = fbUrl(req.body?.url);
  if (!url) throw new HttpError(400, 'วางลิงก์โพสต์จาก Facebook (facebook.com หรือ fb.watch)');
  let post;
  try {
    post = parsePost(await fbFetch(url));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(422, 'ดึงข้อมูลจาก Facebook ไม่สำเร็จ ลองใหม่ หรือกรอกเอง');
  }
  if (!post.text && !post.images.length) {
    throw new HttpError(422, 'ไม่พบข้อความหรือภาพในโพสต์นี้ Facebook อาจขอให้เข้าสู่ระบบก่อน กรอกเองแทนได้');
  }
  const lines = post.text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  res.json({
    sourceUrl: url,
    title: (lines[0] || '').slice(0, 200),
    body: lines.slice(1).join('\n\n') || post.text,
    images: post.images.filter((i) => { try { return FB_IMAGE_HOST.test(new URL(i).hostname); } catch { return false; } }).slice(0, 10),
    date: post.date,
    pageName: post.pageName,
    notes: [
      ...(post.truncated ? ['Facebook ให้ข้อความมาไม่ครบทั้งโพสต์ คัดลอกส่วนที่เหลือจากโพสต์มาวางเพิ่ม'] : []),
      ...(!post.date ? ['ไม่พบวันที่ในโพสต์ เลือกวันที่เผยแพร่เดิมเอง'] : []),
      ...(post.images.length <= 1 ? ['Facebook ให้ภาพมาเพียงภาพเดียว ถ้าโพสต์มีหลายภาพ บันทึกภาพจากโพสต์แล้วแนบเพิ่ม'] : []),
    ],
  });
});

// ---- Possible duplicates: same source link, same unit within 3 days, or a very similar title ----
async function duplicates({ url, unit, date, title }, excludeId = null) {
  const src = url ? fbUrl(url) || String(url).slice(0, 500) : null;
  const rows = (await query(
    `select n.id, n.title, n.unit, n.published_at, n.imported, n.source_url,
       (n.source_url is not null and n.source_url = $1) same_source,
       (n.unit = $2 and $3::date is not null and abs(${LOCAL_DAY} - $3::date) <= 3) near_date,
       ($4::text is not null and word_similarity($4, n.title) >= 0.6) similar_title
     from news n
     where n.withdrawn_at is null and ($5::uuid is null or n.id <> $5) and (
       (n.source_url is not null and n.source_url = $1)
       or (n.unit = $2 and $3::date is not null and abs(${LOCAL_DAY} - $3::date) <= 3)
       or ($4::text is not null and word_similarity($4, n.title) >= 0.6))
     order by same_source desc, similar_title desc, n.published_at desc limit 5`,
    [src, unit || null, /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : null, title?.trim() || null, excludeId])).rows;
  return rows.map((r) => ({
    id: r.id, title: r.title, unit: r.unit, publishedAt: r.published_at, imported: r.imported,
    reasons: [r.same_source && 'ลิงก์ต้นฉบับเดียวกัน', r.near_date && 'หน่วยงานเดียวกัน วันที่ใกล้กัน', r.similar_title && 'ชื่อข่าวคล้ายกัน'].filter(Boolean),
  }));
}

router.get('/pr/import/check', async (req, res) => {
  res.json({ duplicates: await duplicates(req.query) });
});

// ---- Import ----
async function download(url) {
  let u;
  try { u = new URL(url); } catch { throw new HttpError(400, 'ลิงก์ภาพไม่ถูกต้อง'); }
  if (u.protocol !== 'https:' || !FB_IMAGE_HOST.test(u.hostname)) throw new HttpError(400, 'รับภาพจาก Facebook เท่านั้น');
  const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(20000) }).catch(() => null);
  if (!res?.ok) throw new HttpError(422, 'ดาวน์โหลดภาพจาก Facebook ไม่สำเร็จ ลิงก์ภาพอาจหมดอายุ ดึงข้อมูลใหม่อีกครั้ง');
  if (Number(res.headers.get('content-length')) > 15 * MB) throw new HttpError(413, 'ภาพจาก Facebook ใหญ่เกิน 15 MB');
  const path = tempPath('.img');
  let size = 0;
  const limit = new TransformStream({ transform(chunk, ctl) { size += chunk.length; if (size > 15 * MB) ctl.error(new HttpError(413, 'ภาพใหญ่เกิน 15 MB')); else ctl.enqueue(chunk); } });
  await pipeline(Readable.fromWeb(res.body.pipeThrough(limit)), createWriteStream(path));
  return path;
}

// opts.imported: the original date must not be in the future (an edited story that was not imported may be scheduled)
function checkImport(d, photoCount, opts = { imported: true }) {
  if (!d || typeof d !== 'object') throw new HttpError(400, 'ไม่พบข้อมูลข่าว');
  const errors = {};
  const need = (k, ok, msg) => { if (!ok && !errors[k]) errors[k] = msg; };
  const row = {
    kind: d.kind, title: str(d.title, 200, 'หัวข้อข่าว'), lead: str(d.lead, 300, 'สรุปข่าว'), body: str(d.body, 50000, 'เนื้อหาข่าว') || '',
    title_en: str(d.titleEn, 200, 'หัวข้อภาษาอังกฤษ'), body_en: str(d.bodyEn, 50000, 'เนื้อหาภาษาอังกฤษ'),
    unit: str(d.unit, 200, 'หน่วยงาน'), categories: Array.isArray(d.categories) ? [...new Set(d.categories)] : [],
    audience: Array.isArray(d.audience) ? [...new Set(d.audience)] : [], video_url: str(d.videoUrl, 500, 'ลิงก์วิดีโอ'),
    credit: str(d.credit, 80, 'เครดิต'), place: str(d.place, 120, 'สถานที่'),
    body_size: bodySize(d.bodySize), body_leading: bodyLeading(d.bodyLeading),
    source_url: d.sourceUrl ? fbUrl(d.sourceUrl) || str(d.sourceUrl, 500, 'ลิงก์ต้นฉบับ') : null,
    album_url: albumUrl(d.albumUrl),
  };
  need('kind', TYPES.includes(row.kind), 'เลือกประเภทเนื้อหา');
  need('title', row.title, 'กรอกหัวข้อข่าว');
  need('unit', row.unit && allUnits().includes(row.unit), 'เลือกหน่วยงานจากรายการ');
  need('categories', row.kind === 'banner' || row.categories.length > 0, 'เลือกประเภทข่าวอย่างน้อย 1 ประเภท');
  need('categories', row.categories.length <= MAX_CATS && row.categories.every((c) => categories().includes(c)), 'ประเภทข่าวไม่ถูกต้อง');
  need('categories', soloOk(row.categories), SOLO_MSG);
  need('audience', row.audience.length && row.audience.every((a) => AUDIENCES.includes(a)), 'เลือกว่าใครเห็นข่าวนี้ได้');
  if (row.audience.includes('public')) row.audience = [...AUDIENCES];
  if (row.kind === 'news') need('body', row.body.length >= 20, 'ใส่เนื้อหาข่าว');
  if (row.kind !== 'video') need('photos', photoCount > 0, 'แนบภาพอย่างน้อย 1 ภาพ');
  if (row.kind === 'video') need('videoUrl', row.video_url && Object.values(PLATFORMS).some((r) => r.test(row.video_url)), 'ใส่ลิงก์วิดีโอจาก YouTube, Facebook, TikTok หรือ Google Drive');
  if (row.video_url) need('videoUrl', Object.values(PLATFORMS).some((r) => r.test(row.video_url)), 'ลิงก์วิดีโอไม่ถูกต้อง');
  const more = videoLinks(d.videoLinks, row.video_url);
  row.video_links = more.links;
  if (more.error) need('videoLinks', false, more.error);
  if (row.video_links.length) need('videoUrl', row.video_url, 'ใส่ลิงก์วิดีโอหลักก่อนลิงก์เพิ่มเติม');
  // Original date (and time): not in the future
  const date = /^\d{4}-\d{2}-\d{2}$/.test(d.date || '') ? d.date : null;
  const time = /^\d{2}:\d{2}$/.test(d.time || '') ? d.time : '12:00';
  row.published_at = date ? new Date(`${date}T${time}:00+07:00`) : null;
  need('date', row.published_at && !Number.isNaN(row.published_at.getTime()), 'เลือกวันที่เผยแพร่เดิม');
  if (opts.imported) need('date', !row.published_at || row.published_at <= new Date(), 'วันที่เผยแพร่เดิมต้องไม่เกินวันนี้');
  row.date = date;
  if (Object.keys(errors).length) throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', errors);
  return row;
}

router.post('/pr/import', limit('import', { max: 120, windowMs: 10 * 60 * 1000 }), acceptUpload, async (req, res) => {
  const temps = [];
  let newsId = null;
  try {
    const d = req.data;
    const remote = (Array.isArray(d?.remoteImages) ? d.remoteImages : []).slice(0, 10);
    const photos = req.uploads.filter((f) => f.kind === 'photo');
    if (req.uploads.some((f) => f.kind !== 'photo')) throw new HttpError(400, 'แนบได้เฉพาะไฟล์ภาพ');
    const max = get('photos').max;
    if (photos.length + remote.length > max) throw new HttpError(400, `แนบภาพได้ไม่เกิน ${max} ภาพ`);
    const row = checkImport(d, photos.length + remote.length);
    const dupes = await duplicates({ url: row.source_url, unit: row.unit, date: row.date, title: row.title });
    if (dupes.length && d.confirmDuplicate !== true) {
      throw new HttpError(409, 'อาจซ้ำกับข่าวที่มีอยู่แล้ว ตรวจรายการแล้วยืนยันอีกครั้ง', { duplicates: dupes });
    }
    // Photos in the order arranged on the page (photoOrder), else Facebook ones first (as on the post), then uploads
    for (const url of remote) temps.push(await download(url));
    newsId = (await one('select gen_random_uuid() id')).id;
    const all = [...temps.map((t, i) => ({ key: `r:${i}`, path: t, name: `ภาพจาก Facebook ภาพที่ ${i + 1}` })), ...photos.map((f, i) => ({ key: `u:${i}`, path: f.path, name: f.originalname }))];
    const want = Array.isArray(d.photoOrder) ? d.photoOrder.filter((k) => typeof k === 'string') : [];
    const ordered = [...want.map((k) => all.find((x) => x.key === k)).filter(Boolean), ...all.filter((x) => !want.includes(x.key))];
    const paths = [];
    for (const x of [...new Set(ordered)]) paths.push(await publishFile(newsId, x.path, x.name));
    const created = await tx(async (c) => {
      const n = (await c.query(
        `insert into news (id, kind, imported, source_url, title, title_en, lead, body, body_en, unit, categories, audience,
           cover_path, gallery, video_url, credit, place, event_date, published_at, created_by, album_url, body_size, body_leading, reviewed_by, video_links)
         values ($1, $2, true, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $19, $23) returning *`,
        [newsId, row.kind, row.source_url, row.title, row.title_en, row.lead, row.body, row.body_en, row.unit, row.categories, row.audience,
          paths[0] || null, paths.slice(1), row.video_url, row.credit, row.place, row.date, row.published_at, req.user.id, row.album_url,
          row.body_size, row.body_leading, row.video_links])).rows[0];
      await audit(c, req.user, 'news.import', n.id, `นำเข้าข่าวย้อนหลัง "${n.title}" (${row.unit}, ${row.date})`,
        { sourceUrl: row.source_url, duplicatesConfirmed: dupes.length ? dupes.map((x) => x.id) : undefined });
      return n;
    }, req.user);
    res.status(201).json({ news: { id: created.id, title: created.title, unit: created.unit, publishedAt: created.published_at, url: `news.html?id=${created.id}` } });
  } catch (err) {
    if (newsId) await rm(abs(join('media', newsId)), { recursive: true, force: true });
    throw err;
  } finally {
    await removeTemp([...(req.uploads || []), ...temps.map((path) => ({ path }))]);
  }
});
