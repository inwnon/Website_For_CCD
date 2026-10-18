// News digests (เล่มสรุปข่าว) — phase 8
// Reading (digest.html, index.html):
// - GET  /api/digests                     published issues (newest first) + issues still being made (placeholders)
// - GET  /api/digests/:id                 one issue with its stories; drafts only for PR
// PR team (digest-studio.html):
// - GET  /api/pr/digests                  every issue, current week / month included (made ahead, opens on schedule)
// - GET  /api/pr/digests/:id              issue + all stories of its date range + what is left out
// - PUT  /api/pr/digests/:id              { mode, groups } save the book (checked against the page rules)
// - POST /api/pr/digests/:id/reset        back to the automatic layout
// - PUT  /api/pr/digests/:id/cover        multipart "file" JPG/PNG ≤ 10 MB · DELETE removes it
// - PUT  /api/pr/digests/:id/pdf          multipart "file" PDF ≤ 50 MB + "pages", "notA4", "shelf" (page 1 as JPG) · DELETE
// - POST /api/pr/digests/:id/publish · POST /api/pr/digests/:id/unpublish
// Files: GET /media/digests/:id/:file — published issues for anyone, drafts for PR only
import { randomUUID } from 'node:crypto';
import { open as openFile, mkdir, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { audit } from './audit.mjs';
import { isPr, requirePr } from './auth.mjs';
import { one, query, tx } from './db.mjs';
import { UPLOAD_DIR, abs, removeTemp, sendMedia } from './files.mjs';
import { HttpError } from './http.mjs';
import { LIVE, LOCAL_DAY, readableBy } from './news.mjs';
import { PLATFORMS } from './rules.mjs';
import { get } from './settings.mjs';
import { limit, matchesName } from './security.mjs';

// Same rules as digest-book.js: pages count the cover; cover, contents and back cover are fixed
export const RULES = {
  weekly: { maxPages: 12, perPage: 6, maxPagesPerCat: 2 },
  monthly: { maxPages: 48, perPage: 6, maxPagesPerCat: Infinity },
};
const FIXED_PAGES = 3;
const MB = 1024 * 1024;
const BANNER_CAT = 'อินโฟกราฟิก / แบนเนอร์';
const OTHER_CAT = 'ข่าวทั่วไป';
const pagesOfCat = (n, kind) => Math.ceil(n / RULES[kind].perPage);
const pageCount = (kind, groups) => FIXED_PAGES + groups.reduce((a, g) => a + pagesOfCat(g.ids.length, kind), 0);
const catOf = (n) => (n.kind === 'banner' ? BANNER_CAT : n.categories[0] || OTHER_CAT);
const catOrder = () => [...get('categories'), OTHER_CAT, BANNER_CAT];
const TH = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' });

// ---- Stories of an issue's date range ----
const youtubeId = (url) => url?.match(PLATFORMS.youtube)?.[4] || null; // group 4: the video id
export async function pool(d) {
  const rows = (await query(
    `select n.id, n.title, n.unit, n.lead, n.kind, n.categories, n.audience, n.cover_path, n.video_url, n.published_at
     from news n where ${LIVE} and ${LOCAL_DAY} between $1 and $2 order by n.published_at`, [d.range_start, d.range_end])).rows;
  return rows.map((n) => ({
    id: n.id, title: n.title, unit: n.unit, lead: n.lead, cat: catOf(n), audience: n.audience, internal: !n.audience.includes('public'),
    // A video story without a cover: its YouTube picture through this server (news.mjs /media/video), not from YouTube
    img: n.cover_path ? `/media/${n.cover_path}` : youtubeId(n.video_url) ? `/media/video/${youtubeId(n.video_url)}.webp` : null,
    publishedAt: n.published_at,
  }));
}
// Automatic layout: categories in the settings order, each capped, until the book is full
export function autoGroups(kind, stories) {
  const R = RULES[kind];
  let budget = R.maxPages - FIXED_PAGES;
  const cats = [...new Set([...catOrder(), ...stories.map((s) => s.cat)])];
  const out = [];
  for (const cat of cats) {
    const ids = stories.filter((s) => s.cat === cat).map((s) => s.id);
    if (!ids.length) continue;
    const take = Math.min(ids.length, R.perPage * Math.min(R.maxPagesPerCat, 1e6), budget * R.perPage);
    if (take <= 0) break;
    budget -= pagesOfCat(take, kind);
    out.push({ cat, ids: ids.slice(0, take) });
  }
  return out;
}
// The book as a viewer sees it: saved (or automatic) groups, minus stories gone from the site or not readable
function layout(d, stories, user) {
  const ok = new Map(stories.map((s) => [s.id, s]));
  const can = readableBy(user);
  const visible = (id) => ok.has(id) && (isPr(user) || ok.get(id).audience.some((a) => can.includes(a)));
  const groups = (d.edited ? d.groups : autoGroups(d.kind, stories)).map((g) => ({ cat: g.cat, ids: g.ids.filter(visible) })).filter((g) => g.ids.length);
  const used = new Set(groups.flatMap((g) => g.ids));
  return { groups, excluded: stories.filter((s) => !used.has(s.id)).map((s) => s.id) };
}

const fileUrl = (d, rel) => (rel ? `/media/digests/${d.id}/${basename(rel)}` : null);
function out(d, extra = {}) {
  const t = d.theme || {};
  return {
    id: d.id, kind: d.kind, no: d.no, range: d.range_label, rangeStart: d.range_start, rangeEnd: d.range_end,
    status: d.status, mode: d.mode, edited: d.edited, bg: t.bg || '#1B2560', glow: t.glow || 'rgb(222 20 42 / .55)', soft: t.soft || 'bg-red-soft',
    draftedAt: d.drafted_at, open: new Date(d.drafted_at) <= new Date(), publishedAt: d.published_at, published: d.published_at ? TH.format(d.published_at) : null,
    cover: d.cover_path ? { url: fileUrl(d, d.cover_path), ...d.cover_meta } : null,
    pdf: d.pdf_path ? { url: fileUrl(d, d.pdf_path), ...d.pdf_meta } : null,
    shelf: fileUrl(d, d.shelf_path),
    ...extra,
  };
}
// Story count and pages for shelves
function measure(d, groups) {
  if (d.mode === 'pdf') return { count: null, pages: d.pdf_meta?.pages || 0 };
  return { count: groups.reduce((a, g) => a + g.ids.length, 0), pages: pageCount(d.kind, groups) };
}
const storyOut = (s) => ({ id: s.id, title: s.title, unit: s.unit, lead: s.lead, cat: s.cat, img: s.img, internal: s.internal, publishedAt: s.publishedAt });

// The current week and month exist ahead of time so PR can prepare them; they open on schedule
// (weekly: Monday 06:00 after the week, monthly: the 1st at 06:00). Same numbering as create_digest_drafts().
export async function ensureUpcoming() {
  const today = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date()) + 'T00:00:00Z');
  const iso = (dt) => dt.toISOString().slice(0, 10);
  const nextMonday = new Date(today); nextMonday.setUTCDate(today.getUTCDate() + ((8 - (today.getUTCDay() || 7)) % 7 || 7));
  const nextFirst = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  for (const [kind, opens, start] of [
    ['weekly', nextMonday, new Date(nextMonday.getTime() - 7 * 864e5)],
    ['monthly', nextFirst, new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))],
  ]) {
    if (await one('select 1 from digests where kind = $1 and range_start = $2', [kind, iso(start)])) continue;
    await tx(async (c) => {
      const before = new Set((await c.query('select id from digests')).rows.map((r) => r.id));
      // The SQL function makes the issue(s) for the period that ends the day before `opens`
      await c.query('select create_digest_drafts($1)', [iso(opens)]);
      const made = (await c.query('select id, kind, range_start from digests')).rows.filter((r) => !before.has(r.id));
      for (const r of made) {
        // Keep only the issue asked for (a Monday that is also the 1st makes both); it opens at `opens` 06:00
        if (r.kind !== kind) await c.query('delete from digests where id = $1', [r.id]);
        else await c.query(`update digests set drafted_at = ($2::date + time '06:00') at time zone 'Asia/Bangkok' where id = $1`, [r.id, iso(opens)]);
      }
    });
  }
}

async function load(id) {
  if (!/^[wm]-\d{4}-\d{2}(-\d{2})?$/.test(id)) throw new HttpError(404, 'ไม่พบเล่มนี้');
  const d = await one('select * from digests where id = $1', [id]);
  if (!d) throw new HttpError(404, 'ไม่พบเล่มนี้');
  return d;
}

export const router = Router();

// ---- Reading ----
router.get('/digests', async (req, res) => {
  const rows = (await query(`select * from digests order by coalesce(published_at, drafted_at) desc, range_start desc`)).rows;
  const published = [];
  for (const d of rows.filter((x) => x.status === 'published')) {
    const { groups } = layout(d, await pool(d), req.user);
    const stories = d.mode === 'pdf' ? [] : (await pool(d));
    const byId = new Map(stories.map((s) => [s.id, s]));
    // First three stories for the hero's "ในฉบับนี้"
    const top = groups.flatMap((g) => g.ids).slice(0, 3).map((id) => byId.get(id)).filter(Boolean).map(storyOut);
    published.push(out(d, { ...measure(d, groups), top }));
  }
  const waiting = rows.filter((x) => x.status !== 'published').map((d) => out(d)).map(({ id, kind, no, range, draftedAt, open, bg, glow, soft }) => ({ id, kind, no, range, draftedAt, open, bg, glow, soft }));
  res.json({ published, waiting, mastheads: get('digest').mastheads });
});

router.get('/digests/:id', async (req, res) => {
  const d = await load(req.params.id);
  if (d.status !== 'published' && !isPr(req.user)) throw new HttpError(404, 'ไม่พบเล่มนี้');
  const stories = d.mode === 'pdf' ? [] : await pool(d);
  const { groups } = layout(d, stories, req.user);
  const used = new Set(groups.flatMap((g) => g.ids));
  res.json({ digest: out(d, measure(d, groups)), groups, stories: stories.filter((s) => used.has(s.id)).map(storyOut), mastheads: get('digest').mastheads });
});

// ---- PR team ----
router.use('/pr/digests', requirePr);

router.get('/pr/digests', async (req, res) => {
  await ensureUpcoming();
  const rows = (await query(`select d.*, (select count(*)::int from email_outbox o where o.kind = 'digest.reminder' and o.ref = d.id) reminders
    from digests d order by d.range_start desc, d.kind limit 60`)).rows;
  const items = [];
  for (const d of rows) {
    const stories = await pool(d);
    items.push(out(d, { ...measure(d, layout(d, stories, req.user).groups), news: stories.length, reminders: d.reminders }));
  }
  const team = (await query(`select email from pr_team where role in ('pr', 'admin') order by email`)).rows.map((r) => r.email);
  res.json({ items, team, mastheads: get('digest').mastheads });
});

async function studio(req, d) {
  const stories = await pool(d);
  const { groups, excluded } = layout(d, stories, req.user);
  const reminders = (await one(`select count(*)::int n, max(created_at) last from email_outbox where kind = 'digest.reminder' and ref = $1`, [d.id]));
  return { digest: out(d, { ...measure(d, groups), news: stories.length, reminders: reminders.n, lastReminder: reminders.last }), groups, excluded, stories: stories.map(storyOut), mastheads: get('digest').mastheads };
}
router.get('/pr/digests/:id', async (req, res) => res.json(await studio(req, await load(req.params.id))));

const editable = (d) => { if (d.status === 'published') throw new HttpError(409, 'เล่มนี้เผยแพร่แล้ว ถอนเล่มก่อนแก้ไข'); };

// Checks a book against the rules; returns the cleaned groups
function checkGroups(d, stories, groups) {
  if (!Array.isArray(groups)) throw new HttpError(400, 'ข้อมูลเล่มไม่ถูกต้อง');
  const R = RULES[d.kind];
  const byId = new Map(stories.map((s) => [s.id, s]));
  const seen = new Set();
  const clean = [];
  for (const g of groups) {
    const ids = (Array.isArray(g?.ids) ? g.ids : []).filter((id) => typeof id === 'string');
    for (const id of ids) {
      const s = byId.get(id);
      if (!s) throw new HttpError(400, 'มีข่าวที่ไม่อยู่ในช่วงวันที่ของเล่มนี้');
      if (s.cat !== g.cat) throw new HttpError(400, `ข่าว "${s.title}" อยู่ผิดประเภท`);
      if (seen.has(id)) throw new HttpError(400, 'มีข่าวซ้ำในเล่ม');
      seen.add(id);
    }
    if (!ids.length) continue;
    if (pagesOfCat(ids.length, d.kind) > R.maxPagesPerCat) throw new HttpError(400, `ประเภท ${g.cat} เกิน ${R.maxPagesPerCat} หน้า`);
    clean.push({ cat: g.cat, ids });
  }
  if (pageCount(d.kind, clean) > R.maxPages) throw new HttpError(400, `เล่มเกิน ${R.maxPages} หน้า`);
  return clean;
}

router.put('/pr/digests/:id', async (req, res) => {
  const d = await load(req.params.id);
  editable(d);
  const b = req.body || {};
  const mode = b.mode === 'pdf' ? 'pdf' : 'auto';
  const sets = { mode };
  if (b.groups !== undefined) sets.groups = checkGroups(d, await pool(d), b.groups);
  await tx(async (c) => {
    if (sets.groups) await c.query('update digests set mode = $2, groups = $3, edited = true where id = $1', [d.id, mode, JSON.stringify(sets.groups)]);
    else await c.query('update digests set mode = $2 where id = $1', [d.id, mode]);
    // One history row per issue per hour is enough for small edits
    const recent = await c.query(`select 1 from audit_log where action = 'digest.update' and target = $1 and actor_id = $2 and at > now() - interval '1 hour'`, [d.id, req.user.id]);
    if (!recent.rowCount) await audit(c, req.user, 'digest.update', d.id, `จัดเล่มสรุปข่าว ฉบับ ${d.range_label}`, { mode });
  });
  res.json(await studio(req, await load(d.id)));
});

router.post('/pr/digests/:id/reset', async (req, res) => {
  const d = await load(req.params.id);
  editable(d);
  await query(`update digests set groups = '[]', edited = false where id = $1`, [d.id]);
  await audit(null, req.user, 'digest.reset', d.id, `ล้างการจัดเล่ม ฉบับ ${d.range_label} กลับเป็นที่ระบบจัดให้`);
  res.json(await studio(req, await load(d.id)));
});

// ---- Cover and PDF files ----
const TMP = join(UPLOAD_DIR, 'tmp');
const upload = multer({ dest: TMP, limits: { fileSize: 50 * MB, files: 2, fields: 5 }, defParamCharset: 'utf8' })
  .fields([{ name: 'file', maxCount: 1 }, { name: 'shelf', maxCount: 1 }]);
const fileLimit = limit('digestFile', { max: 60, windowMs: 10 * 60 * 1000 });
const acceptFiles = (req, res, next) => fileLimit(req, res, () => upload(req, res, (err) => {
  if (err) return next(new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ใหญ่เกิน 50 MB' : 'อัปโหลดไฟล์ไม่สำเร็จ'));
  req.digestFiles = { file: req.files?.file?.[0], shelf: req.files?.shelf?.[0] };
  next();
}));
const temps = (req) => Object.values(req.digestFiles || {}).filter(Boolean);
const dirOf = (d) => join('digests', d.id);
const removeRel = (rel) => (rel ? rm(abs(rel), { force: true }) : null);

router.put('/pr/digests/:id/cover', acceptFiles, async (req, res) => {
  try {
    const d = await load(req.params.id);
    editable(d);
    const f = req.digestFiles.file;
    if (!f) throw new HttpError(400, 'เลือกรูปปก');
    if (!/\.(jpe?g|png)$/i.test(f.originalname) || !(await matchesName(f.path, f.originalname))) throw new HttpError(400, 'ใช้ไฟล์ JPG หรือ PNG');
    if (f.size > 10 * MB) throw new HttpError(413, 'รูปปกใหญ่เกิน 10 MB');
    let meta;
    try { meta = await sharp(f.path).rotate().metadata(); } catch { throw new HttpError(400, 'เปิดรูปนี้ไม่ได้ ลองบันทึกเป็น JPG หรือ PNG ใหม่'); }
    await mkdir(abs(dirOf(d)), { recursive: true });
    const rel = join(dirOf(d), `cover-${randomUUID()}.jpg`).replaceAll('\\', '/');
    // Re-encoded: no EXIF / GPS on the public cover
    await sharp(f.path).rotate().jpeg({ quality: 88, mozjpeg: true }).toFile(abs(rel));
    const w = meta.orientation >= 5 ? meta.height : meta.width, h = meta.orientation >= 5 ? meta.width : meta.height;
    await query('update digests set cover_path = $2, cover_meta = $3 where id = $1', [d.id, rel, JSON.stringify({ name: f.originalname.slice(0, 200), size: f.size, w, h })]);
    await audit(null, req.user, 'digest.file', d.id, `อัปโหลดรูปปกเล่ม ฉบับ ${d.range_label}`, { file: f.originalname.slice(0, 200) });
    await removeRel(d.cover_path);
    res.json(await studio(req, await load(d.id)));
  } finally { await removeTemp(temps(req)); }
});
router.delete('/pr/digests/:id/cover', async (req, res) => {
  const d = await load(req.params.id);
  editable(d);
  await query('update digests set cover_path = null, cover_meta = null where id = $1', [d.id]);
  await audit(null, req.user, 'digest.file', d.id, `ลบรูปปกเล่ม ฉบับ ${d.range_label}`);
  await removeRel(d.cover_path);
  res.json(await studio(req, await load(d.id)));
});

router.put('/pr/digests/:id/pdf', acceptFiles, async (req, res) => {
  try {
    const d = await load(req.params.id);
    editable(d);
    const f = req.digestFiles.file;
    if (!f) throw new HttpError(400, 'เลือกไฟล์ PDF');
    const fh = await openFile(f.path, 'r');
    const head = Buffer.alloc(5);
    await fh.read(head, 0, 5, 0); await fh.close();
    if (head.toString() !== '%PDF-') throw new HttpError(400, 'ไฟล์นี้ไม่ใช่ PDF');
    const pages = Number(req.body?.pages);
    if (!Number.isInteger(pages) || pages < 1) throw new HttpError(400, 'ไม่ทราบจำนวนหน้าของไฟล์');
    if (pages > RULES[d.kind].maxPages) throw new HttpError(400, `ไฟล์นี้มี ${pages} หน้า เกิน ${RULES[d.kind].maxPages} หน้า (รวมปก)`);
    await mkdir(abs(dirOf(d)), { recursive: true });
    const rel = join(dirOf(d), `issue-${randomUUID()}.pdf`).replaceAll('\\', '/');
    await (await import('node:fs/promises')).rename(f.path, abs(rel));
    let shelf = null;
    if (req.digestFiles.shelf) {
      shelf = join(dirOf(d), `shelf-${randomUUID()}.jpg`).replaceAll('\\', '/');
      try { await sharp(req.digestFiles.shelf.path).resize(620).jpeg({ quality: 84 }).toFile(abs(shelf)); } catch { shelf = null; }
    }
    await query('update digests set pdf_path = $2, pdf_meta = $3, shelf_path = $4 where id = $1',
      [d.id, rel, JSON.stringify({ name: f.originalname.slice(0, 200), size: f.size, pages, notA4: req.body?.notA4 === '1' }), shelf]);
    await audit(null, req.user, 'digest.file', d.id, `อัปโหลดไฟล์ PDF ของเล่ม ฉบับ ${d.range_label}`, { file: f.originalname.slice(0, 200) });
    await Promise.all([removeRel(d.pdf_path), removeRel(d.shelf_path)]);
    res.json(await studio(req, await load(d.id)));
  } finally { await removeTemp(temps(req)); }
});
router.delete('/pr/digests/:id/pdf', async (req, res) => {
  const d = await load(req.params.id);
  editable(d);
  await query('update digests set pdf_path = null, pdf_meta = null, shelf_path = null where id = $1', [d.id]);
  await audit(null, req.user, 'digest.file', d.id, `ลบไฟล์ PDF ของเล่ม ฉบับ ${d.range_label}`);
  await Promise.all([removeRel(d.pdf_path), removeRel(d.shelf_path)]);
  res.json(await studio(req, await load(d.id)));
});

// ---- Approve ----
router.post('/pr/digests/:id/publish', async (req, res) => {
  const d = await load(req.params.id);
  editable(d);
  if (new Date(d.drafted_at) > new Date()) throw new HttpError(409, `อนุมัติได้หลังระบบจัดเล่ม ${TH.format(d.drafted_at)}`);
  const stories = await pool(d);
  const { groups } = layout(d, stories, req.user);
  if (d.mode === 'pdf' && !d.pdf_path) throw new HttpError(409, 'อัปโหลด PDF ก่อนอนุมัติ');
  if (d.mode === 'auto' && !groups.length) throw new HttpError(409, 'ยังไม่มีข่าวในเล่ม');
  await tx(async (c) => {
    // The book is fixed as approved; stories published later do not move into it
    await c.query(`update digests set status = 'published', published_at = now(), approved_by = $2, groups = $3, edited = true where id = $1`, [d.id, req.user.id, JSON.stringify(groups)]);
    await audit(c, req.user, 'digest.publish', d.id, `เผยแพร่เล่มสรุปข่าว ฉบับ ${d.range_label}`, { mode: d.mode, stories: groups.reduce((a, g) => a + g.ids.length, 0) });
  });
  res.json(await studio(req, await load(d.id)));
});
router.post('/pr/digests/:id/unpublish', async (req, res) => {
  const d = await load(req.params.id);
  if (d.status !== 'published') throw new HttpError(409, 'เล่มนี้ยังไม่ได้เผยแพร่');
  await tx(async (c) => {
    await c.query(`update digests set status = 'review', published_at = null where id = $1`, [d.id]);
    await audit(c, req.user, 'digest.unpublish', d.id, `ถอนเล่มสรุปข่าว ฉบับ ${d.range_label} ออกจากชั้นหนังสือ`);
  });
  res.json(await studio(req, await load(d.id)));
});

// ---- Files ----
export const media = Router();
media.get('/:id/:file', async (req, res) => {
  const { id, file } = req.params;
  if (!/^[wm]-\d{4}-\d{2}(-\d{2})?$/.test(id) || !/^(cover|shelf|issue)-[0-9a-f-]{36}\.(jpg|pdf)$/.test(file)) return res.status(404).end();
  const d = await one('select * from digests where id = $1', [id]);
  const rel = d && [d.cover_path, d.pdf_path, d.shelf_path].find((p) => p && basename(p) === file);
  if (!rel || (d.status !== 'published' && !isPr(req.user))) return res.status(404).end();
  const name = req.query.download === '1' ? `${get('digest').mastheads[d.kind].replace(/\s+/g, '-')}-No.${d.no}-${d.range_label.replace(/[\s/–]+/g, '-')}${extname(file)}` : null;
  sendMedia(res, rel, d.status === 'published' ? 'public, max-age=3600' : 'private, no-cache', name);
});
