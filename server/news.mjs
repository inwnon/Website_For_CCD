// Published stories — reading side (index.html, news.html, search.html)
// - GET    /api/news?feed=1&featured=1&range=today|week|month&date=YYYY-MM-DD&limit=&offset=
//          live stories, newest first. feed=1 is the home page: imported (นำเข้าย้อนหลัง) stories are left out.
//          Stories the viewer may not read come back as { locked: true } placeholders.
// - GET    /api/news/search?q=&kind=&cat=&cat=&unit=&from=&to=&sort=relevance|newest&limit=&offset=
//          search and filters (search.html, unit pages). Only stories the viewer may read; never placeholders.
// - GET    /api/news/archive?year=2026      { years, months: { '01': n }, days: { 'YYYY-MM-DD': n } }
// - GET    /api/news/:id                     full story + related; 401/403 { locked } internal, 410 { withdrawn }
// - POST   /api/news/:id/read  { ref }       counts a read: once per reader per story per day, bots ignored
// - GET    /api/me/saved                     { ids } of the signed-in user's saved stories
// - PUT    /api/news/:id/save · DELETE /api/news/:id/save
// - GET    /media/:newsId/:file              story images; internal stories only for readers who may see them
// - GET    /media/:newsId/photos.zip         all photos of a story in one ZIP (full size when there is one)
// - GET    /media/video/:youtubeId.webp      a story video's YouTube thumbnail, fetched and kept by this server
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { Router } from 'express';
import { isPr, requireUser } from './auth.mjs';
import { one, query, tx } from './db.mjs';
import { abs, sendMedia } from './files.mjs';
import { HttpError } from './http.mjs';
import { unitFamily } from './org.mjs';
import { PLATFORMS, TYPES, albumHost, audienceLabel } from './rules.mjs';
import { limit } from './security.mjs';
import { searchTerms } from './thai.mjs';
import archiver from 'archiver';
import sharp from 'sharp';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const LIVE = 'n.published_at <= now() and n.withdrawn_at is null';
export const LOCAL_DAY = "(n.published_at at time zone 'Asia/Bangkok')::date";
const TODAY = "(now() at time zone 'Asia/Bangkok')::date";

// Audiences a viewer may read. Internal news (no 'public') needs a signed-in account of that group.
export function readableBy(user) {
  if (!user) return ['public'];
  if (isPr(user)) return ['public', 'student', 'staff'];
  if (user.role === 'staff' || user.role === 'coordinator') return ['public', 'staff'];
  if (user.role === 'student') return ['public', 'student'];
  return ['public'];
}
const canRead = (story, user) => story.audience.some((a) => readableBy(user).includes(a));

// Published images: {file}.webp (1600px) and, when the original could be decoded, {file}.full.jpg (no GPS/EXIF)
const mediaUrl = (path) => `/media/${path}`;
// srcset of the 480 / 960 / 1600px copies, for <img srcset> (the smaller ones are made on first request)
export const srcset = (path) => (/\.webp$/.test(path)
  ? [480, 960].map((w) => `${mediaUrl(path.replace(/\.webp$/, `.w${w}.webp`))} ${w}w`).concat(`${mediaUrl(path)} 1600w`).join(', ')
  : null);
const image = (path) => {
  const full = path.replace(/\.webp$/, '.full.jpg');
  return { web: mediaUrl(path), set: srcset(path), full: existsSync(abs(`media/${full}`)) ? mediaUrl(full) : null };
};
const platformOf = (url) => (url ? Object.keys(PLATFORMS).find((p) => PLATFORMS[p].test(url)) || null : null);
const youtubeId = (url) => url?.match(PLATFORMS.youtube)?.[5] || null;
// Served by this site (media/video), see youtubeThumb below
const videoThumb = (n) => (youtubeId(n.video_url) ? `/media/video/${youtubeId(n.video_url)}.webp` : null);

export function cardOut(n, user) {
  const base = { id: n.id, publishedAt: n.published_at, audience: audienceLabel(n.audience) };
  if (!canRead(n, user)) return { ...base, locked: true };
  return {
    ...base, title: n.title, lead: n.lead, unit: n.unit, kind: n.kind, categories: n.categories, featured: n.featured, views: n.views,
    cover: n.cover_path ? mediaUrl(n.cover_path) : null, coverSet: n.cover_path ? srcset(n.cover_path) : null, photos: (n.cover_path ? 1 : 0) + n.gallery.length,
    video: !!n.video_url, videoThumb: videoThumb(n), en: !!(n.title_en || n.body_en), internal: !n.audience.includes('public'),
  };
}

export const router = Router();

// ---- Home page lists and the archive day view ----
router.get('/news', async (req, res) => {
  const { featured, range, date, feed } = req.query;
  const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 48);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const where = [LIVE];
  const params = [];
  if (feed === '1') where.push('not n.imported');
  if (featured === '1') where.push('n.featured');
  if (range === 'today') where.push(`${LOCAL_DAY} = ${TODAY}`);
  // Week = Sunday–Saturday, as the calendar on index.html
  if (range === 'week') where.push(`${LOCAL_DAY} between ${TODAY} - extract(dow from ${TODAY})::int and ${TODAY} - extract(dow from ${TODAY})::int + 6`);
  if (range === 'month') where.push(`date_trunc('month', ${LOCAL_DAY}) = date_trunc('month', ${TODAY})`);
  if (typeof date === 'string' && DAY.test(date)) { params.push(date); where.push(`${LOCAL_DAY} = $${params.length}::date`); }
  const rows = (await query(
    `select n.*, count(*) over ()::int total from news n where ${where.join(' and ')}
     order by n.published_at desc, n.id limit ${limit} offset ${offset}`, params)).rows;
  const total = rows[0]?.total ?? 0;
  res.json({ total, hasMore: offset + rows.length < total, items: rows.map((n) => cardOut(n, req.user)) });
});

// ---- Search ----
// Each term (text between spaces) must appear in the title, summary or body, or nearly appear (a small typo) in the
// title or summary — or, for Thai typed without spaces, every word of it must appear (thai.mjs cuts the words).
// Score: title ×3, summary ×2, body ×1; a near match counts by its similarity; matching only word by word counts less.
const FUZZY = 0.45;
const many = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(String).filter(Boolean);
const like = (t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`;

function snippet(n, terms) {
  const text = [n.lead, n.body].filter(Boolean).join(' · ').replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  const at = terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) return text.slice(0, 160) + (text.length > 160 ? '…' : '');
  const start = Math.max(0, at - 50);
  return (start ? '…' : '') + text.slice(start, start + 170) + (start + 170 < text.length ? '…' : '');
}

// Search results as the API sends them; also used by pages.mjs to put the first page of results in search.html
export async function searchPayload(qs, user) {
  const q = typeof qs.q === 'string' ? qs.q.trim().slice(0, 100) : '';
  const parsed = searchTerms(q);
  // For highlighting and the snippet: the phrases, then their words
  const terms = [...new Set([...parsed.map((t) => t.phrase), ...parsed.flatMap((t) => t.words)])];
  const limit = Math.min(Math.max(Number(qs.limit) || 12, 1), 48);
  const offset = Math.max(Number(qs.offset) || 0, 0);
  const params = [readableBy(user)];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const where = [LIVE, 'n.audience && $1::audience[]'];
  const score = [];
  const anywhere = (lk) => `(n.title ilike ${lk} or n.lead ilike ${lk} or n.body ilike ${lk} or n.title_en ilike ${lk})`;
  for (const { phrase, words } of parsed) {
    const lk = p(like(phrase)), raw = p(phrase);
    const wordLikes = words.map((w) => p(like(w)));
    const byWords = wordLikes.length ? ` or (${wordLikes.map(anywhere).join(' and ')})` : '';
    where.push(`(${anywhere(lk)}
      or word_similarity(${raw}, n.title) >= ${FUZZY} or word_similarity(${raw}, coalesce(n.lead, '')) >= ${FUZZY}${byWords})`);
    score.push(`3 * greatest((n.title ilike ${lk})::int, word_similarity(${raw}, n.title))
      + 2 * greatest((n.lead ilike ${lk})::int, word_similarity(${raw}, coalesce(n.lead, '')))
      + (n.body ilike ${lk})::int${wordLikes.map((w) => ` + 0.5 * (n.title ilike ${w})::int + 0.2 * (n.lead ilike ${w} or n.body ilike ${w})::int`).join('')}`);
  }
  const kind = TYPES.includes(qs.kind) ? qs.kind : null;
  if (kind) where.push(`n.kind = ${p(kind)}`);
  const cats = many(qs.cat).slice(0, 10);
  if (cats.length) where.push(`n.categories && ${p(cats)}::text[]`);
  const unit = typeof qs.unit === 'string' && qs.unit.trim() ? qs.unit.trim().slice(0, 200) : null;
  if (unit) where.push(`n.unit = any(${p(unitFamily(unit))})`);
  if (DAY.test(qs.from || '')) where.push(`${LOCAL_DAY} >= ${p(qs.from)}::date`);
  if (DAY.test(qs.to || '')) where.push(`${LOCAL_DAY} <= ${p(qs.to)}::date`);
  const byScore = terms.length && qs.sort !== 'newest';
  const rows = (await query(
    `select n.*, ${score.length ? score.join(' + ') : '0'} score, count(*) over ()::int total from news n
     where ${where.join(' and ')}
     order by ${byScore ? 'score desc, ' : ''}n.published_at desc, n.id limit ${limit} offset ${offset}`, params)).rows;
  const total = rows[0]?.total ?? 0;
  return {
    total, hasMore: offset + rows.length < total, terms,
    items: rows.map((n) => ({ ...cardOut(n, user), snippet: snippet(n, terms) })),
  };
}
router.get('/news/search', limit('search', { by: 'ip', max: 120, windowMs: 60 * 1000 }), async (req, res) => {
  res.json(await searchPayload(req.query, req.user));
});

// Counts for the archive (all live stories, internal and imported ones included — a count reveals nothing)
router.get('/news/archive', async (req, res) => {
  const years = (await query(`select distinct extract(year from ${LOCAL_DAY})::int y from news n where ${LIVE} order by y desc`)).rows.map((r) => r.y);
  const year = Number(req.query.year) || years[0] || new Date().getFullYear();
  const days = (await query(
    `select to_char(${LOCAL_DAY}, 'YYYY-MM-DD') d, count(*)::int n from news n
     where ${LIVE} and extract(year from ${LOCAL_DAY}) = $1 group by 1 order by 1`, [year])).rows;
  const months = {};
  for (const r of days) months[r.d.slice(5, 7)] = (months[r.d.slice(5, 7)] || 0) + r.n;
  const first = await one(`select to_char(min(${LOCAL_DAY}), 'YYYY-MM-DD') d from news n where ${LIVE}`);
  res.json({ years, year, first: first?.d ?? null, today: (await one(`select to_char(${TODAY}, 'YYYY-MM-DD') d`)).d,
    months, days: Object.fromEntries(days.map((r) => [r.d, r.n])) });
});

// ---- One story ----
async function readable(req, id = req.params.id) {
  if (!UUID.test(id || '')) throw new HttpError(404, 'ไม่พบข่าวนี้');
  const n = await one('select n.*, n.published_at <= now() live from news n where n.id = $1', [id]);
  if (!n || (!n.live && !isPr(req.user))) throw new HttpError(404, 'ไม่พบข่าวนี้');
  if (n.withdrawn_at) {
    throw new HttpError(410, 'ข่าวนี้ถูกถอนแล้ว', { withdrawn: true, reason: n.withdrawn_reason, at: n.withdrawn_at, title: n.title });
  }
  if (!canRead(n, req.user)) {
    throw new HttpError(req.user ? 403 : 401, req.user ? `ข่าวนี้สำหรับ${audienceLabel(n.audience)}` : 'เข้าสู่ระบบเพื่ออ่านข่าวนี้',
      { locked: true, audience: audienceLabel(n.audience), signedIn: !!req.user });
  }
  return n;
}

// One story and four related ones, as the API and the server-rendered news.html (pages.mjs) send it.
// Throws HttpError 404 / 410 / 401 / 403 like readable().
export async function storyPayload(req, id) {
  const n = await readable(req, id);
  const related = (await query(
    `select n.* from news n where ${LIVE} and n.id <> $1 and n.audience && $3::audience[]
     order by (n.categories && $2) desc, n.published_at desc limit 4`, [n.id, n.categories, readableBy(req.user)])).rows;
  const saved = req.user ? !!(await one('select 1 from saved_news where user_id = $1 and news_id = $2', [req.user.id, n.id])) : false;
  return {
    raw: n,
    story: {
      id: n.id, kind: n.kind, title: n.title, titleEn: n.title_en, lead: n.lead, body: n.body, bodyEn: n.body_en, unit: n.unit,
      categories: n.categories, audience: audienceLabel(n.audience), internal: !n.audience.includes('public'),
      cover: n.cover_path ? image(n.cover_path) : null, gallery: n.gallery.map(image),
      videoUrl: n.video_url, videoPlatform: platformOf(n.video_url), videoThumb: videoThumb(n),
      albumUrl: n.album_url, albumHost: n.album_url ? albumHost(n.album_url) : null,
      credit: n.credit, eventDate: n.event_date, place: n.place, featured: n.featured, views: n.views,
      publishedAt: n.published_at, saved,
    },
    related: related.map((r) => cardOut(r, req.user)),
  };
}
router.get('/news/:id', async (req, res) => {
  const { story, related } = await storyPayload(req, req.params.id);
  res.json({ story, related });
});

// ---- Reads ----
// One per reader per story per Bangkok day. Signed-in readers count by account; others by a hash of
// IP + browser with a salt that changes daily (no IP is stored). Bots and link previews are not counted.
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|headless|lighthouse|pingdom|curl|wget|python|axios|node-fetch|undici|go-http|java\/|^node$/i;
const SALT = process.env.READ_SALT || randomBytes(16).toString('hex');
const OWN_HOST = (() => { try { return new URL(process.env.APP_ORIGIN || 'http://localhost:3000').host; } catch { return ''; } })();
export const SOURCES = ['search', 'facebook', 'line', 'internal', 'direct', 'other'];
export const DEVICES = ['mobile', 'tablet', 'desktop'];

export function sourceOf(ref) {
  if (!ref) return 'direct';
  let host;
  try { host = new URL(ref).host.toLowerCase(); } catch { return 'other'; }
  if (host === OWN_HOST) return 'internal';
  if (/(^|\.)(google|bing|yahoo|duckduckgo|baidu|yandex)\./.test(host)) return 'search';
  if (/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com|instagram\.com)$/.test(host)) return 'facebook';
  if (/(^|\.)line\.(me|naver\.jp)$/.test(host) || host === 'liff.line.me') return 'line';
  return 'other';
}
export function deviceOf(ua) {
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

router.post('/news/:id/read', limit('read', { by: 'ip', max: 300, windowMs: 10 * 60 * 1000 }), async (req, res) => {
  const ua = req.get('user-agent') || '';
  if (!ua || BOT.test(ua)) return res.json({ counted: false });
  const n = await readable(req);
  if (!n.live) return res.json({ counted: false });
  const day = (await one(`select to_char(${TODAY}, 'YYYY-MM-DD') d`)).d;
  const reader = req.user ? `u:${req.user.id}` : `a:${createHash('sha256').update(`${req.ip}|${ua}|${day}|${SALT}`).digest('hex').slice(0, 32)}`;
  const ref = typeof req.body?.ref === 'string' ? req.body.ref.slice(0, 500) : '';
  const source = sourceOf(ref), device = deviceOf(ua);
  const counted = await tx(async (c) => {
    const ins = await c.query(`insert into news_reads (news_id, day, reader, source, device) values ($1, $2, $3, $4, $5)
      on conflict do nothing returning 1`, [n.id, day, reader, source, device]);
    if (!ins.rowCount) return false;
    await c.query(`insert into news_reads_daily (news_id, day, source, device, n) values ($1, $2, $3, $4, 1)
      on conflict (news_id, day, source, device) do update set n = news_reads_daily.n + 1`, [n.id, day, source, device]);
    await c.query('update news set views = views + 1 where id = $1', [n.id]);
    return true;
  });
  res.json({ counted });
});

// ---- Saved stories ----
router.get('/me/saved', requireUser, async (req, res) => {
  const rows = (await query('select news_id from saved_news where user_id = $1 order by created_at desc', [req.user.id])).rows;
  res.json({ ids: rows.map((r) => r.news_id) });
});

router.put('/news/:id/save', requireUser, async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบข่าวนี้');
  const n = await one(`select n.id, n.audience from news n where n.id = $1 and ${LIVE}`, [req.params.id]);
  if (!n || !canRead(n, req.user)) throw new HttpError(404, 'ไม่พบข่าวนี้');
  await query('insert into saved_news (user_id, news_id) values ($1, $2) on conflict do nothing', [req.user.id, n.id]);
  res.json({ saved: true });
});

router.delete('/news/:id/save', requireUser, async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบข่าวนี้');
  await query('delete from saved_news where user_id = $1 and news_id = $2', [req.user.id, req.params.id]);
  res.json({ saved: false });
});

// ---- Images (mounted outside /api) ----
// Public stories are cached by anyone; internal ones only privately in the reader's browser.
// Withdrawn and scheduled stories: PR only.
export const media = Router();
const mediaStory = async (req) => {
  const n = await one(`select n.id, n.audience, n.cover_path, n.gallery, n.published_at, n.title,
    n.published_at <= now() and n.withdrawn_at is null live from news n where n.id = $1`, [req.params.newsId]);
  return n && (n.live || isPr(req.user)) && canRead(n, req.user) ? n : null;
};

// YouTube thumbnails through this server: readers' browsers never contact YouTube for a story's video picture.
// Fetched once per video (only videos of stories on the site), stored as WebP in media/video/{id}.webp.
const thumbsInFlight = new Map();
async function youtubeThumb(id) {
  const rel = `media/video/${id}.webp`;
  if (existsSync(abs(rel))) return rel;
  if (!thumbsInFlight.has(id)) {
    thumbsInFlight.set(id, (async () => {
      const r = await fetch(`https://img.youtube.com/vi/${id}/hqdefault.jpg`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`youtube ${r.status}`);
      await mkdir(abs('media/video'), { recursive: true });
      await sharp(Buffer.from(await r.arrayBuffer())).resize(640, 360, { fit: 'cover' }).webp({ quality: 80 }).toFile(abs(rel));
      return rel;
    })().finally(() => thumbsInFlight.delete(id)));
  }
  return thumbsInFlight.get(id);
}
media.get('/video/:file', async (req, res) => {
  const id = req.params.file.match(/^([\w-]{6,20})\.webp$/)?.[1];
  if (!id) return res.status(404).end();
  // Only a video that a live story links to (not an open image proxy)
  const known = await one(`select 1 from news n where n.video_url like $1 and ${LIVE} limit 1`, [`%${id}%`]);
  if (!known) return res.status(404).end();
  try {
    sendMedia(res, await youtubeThumb(id), 'public, max-age=604800');
  } catch {
    res.status(404).end();
  }
});

// Photos in page order, named 01.jpg, 02.jpg… Stored as-is (JPEG/WebP are already compressed).
media.get('/:newsId/photos.zip', async (req, res) => {
  if (!UUID.test(req.params.newsId)) return res.status(404).end();
  const n = await mediaStory(req);
  const paths = n ? [n.cover_path, ...n.gallery].filter(Boolean) : [];
  if (!paths.length) return res.status(404).end();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(n.published_at);
  const name = `ข่าว-มรส-${day}-${n.title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60)}.zip`;
  res.set('Cache-Control', n.live && n.audience.includes('public') ? 'public, max-age=3600' : 'private, no-cache');
  res.attachment(name);
  const zip = archiver('zip', { store: true });
  zip.on('error', () => res.destroy());
  zip.pipe(res);
  const pad = String(paths.length).length < 2 ? 2 : String(paths.length).length;
  paths.forEach((p, i) => {
    const full = p.replace(/\.webp$/, '.full.jpg');
    const useFull = existsSync(abs(`media/${full}`));
    // Streams keep the queue order (zip.file() reads file info in parallel, which can reorder entries)
    zip.append(createReadStream(abs(`media/${useFull ? full : p}`)), { name: `${String(i + 1).padStart(pad, '0')}.${useFull ? 'jpg' : 'webp'}` });
  });
  zip.finalize();
});

// Smaller copies for cards and phones ({id}.w480.webp, {id}.w960.webp): made from the 1600px copy the first time
// they are asked for, then kept next to it
const resizing = new Map();
async function sized(newsId, file) {
  const [, id, w] = file.match(/^([0-9a-f-]{36})\.w(480|960)\.webp$/i);
  const rel = `media/${newsId}/${file}`;
  if (existsSync(abs(rel))) return;
  const key = `${newsId}/${file}`;
  if (!resizing.has(key)) {
    resizing.set(key, sharp(abs(`media/${newsId}/${id}.webp`)).resize(Number(w), null, { withoutEnlargement: true }).webp({ quality: 78 }).toFile(abs(rel))
      .finally(() => resizing.delete(key)));
  }
  await resizing.get(key);
}

media.get('/:newsId/:file', async (req, res) => {
  const { newsId, file } = req.params;
  if (!UUID.test(newsId) || !/^[0-9a-f-]{36}(\.full\.jpg|\.webp|\.w480\.webp|\.w960\.webp)$/i.test(file)) return res.status(404).end();
  const n = await mediaStory(req);
  if (!n) return res.status(404).end();
  if (/\.w\d+\.webp$/.test(file)) {
    try { await sized(newsId, file); } catch { return res.status(404).end(); }
  }
  const open = n.live && n.audience.includes('public');
  sendMedia(res, `media/${newsId}/${file}`, open ? 'public, max-age=86400' : 'private, no-cache',
    req.query.download === '1' ? `ข่าว-มรส-${file.slice(0, 8)}${file.endsWith('.jpg') ? '.jpg' : '.webp'}` : null);
});
