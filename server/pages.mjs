// Pages rendered on the server, for search engines and link previews (Facebook, LINE) and a faster first paint
// - GET /news.html?id=…   the story's title, summary, body and lead photo are in the HTML, with Open Graph tags,
//                          JSON-LD (NewsArticle), a canonical URL, and the data the page script needs (window.__NEWS)
//                          so it renders without waiting for the API. Internal stories: noindex, content only for
//                          readers who may read them; 404 / 410 for missing / withdrawn stories.
// - GET /search.html       the first page of results for the URL's search, in the page (window.__SEARCH)
// - GET /sitemap.xml       reader pages and every live public story
// - GET /robots.txt        back office, API and sign-in pages are not for crawlers
// - noindex()              X-Robots-Tag on pages that are not for search results
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Router } from 'express';
import { loadUser } from './auth.mjs';
import { query } from './db.mjs';
import { LIVE, searchPayload, storyPayload } from './news.mjs';
import { plainText } from './rules.mjs';

const ROOT = resolve(import.meta.dirname, '..');
export const ORIGIN = (process.env.APP_ORIGIN || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const SITE = 'คลังข่าว มรส.';
const OG_DEFAULT = '/assets/img/og-default.jpg';

// Pages that are not for search results (signed-in tools, sign-in, errors)
export const PRIVATE_PAGES = new Set(['login.html', 'submit.html', 'inbox.html', 'pr.html', 'pr-news.html', 'pr-collections.html', 'pr-import.html', 'report.html',
  'calendar.html', 'requests.html', 'documents.html', 'phonebook.html', 'chanon.html', 'status.html', '404.html', 'maintenance.html']);
export function noindex(req, res, next) {
  const page = req.path.replace(/^\//, '');
  if (PRIVATE_PAGES.has(page)) res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
}

// Files read once, again when they change
const files = new Map();
async function read(rel) {
  const file = join(ROOT, rel);
  const { mtimeMs } = await stat(file);
  const c = files.get(rel);
  if (c?.at === mtimeMs) return c.text;
  const text = await readFile(file, 'utf8');
  files.set(rel, { at: mtimeMs, text });
  return text;
}
// Reader pages carry their CSS in the page (about 11 KB gzipped): the first paint does not wait for another request.
// Fonts in app.css use /assets/fonts/ paths, so they resolve the same from the page.
const INLINE = { app: /<link rel="stylesheet" href="\/assets\/app\.css\?v=[0-9a-f]+">/, desk: '<link rel="stylesheet" href="desk.css">' };
async function readerPage(rel) {
  let html = await read(rel);
  if (INLINE.app.test(html)) { const css = await read('assets/app.css'); html = html.replace(INLINE.app, () => `<style>${css}</style>`); }
  if (html.includes(INLINE.desk)) { const css = await read('desk.css'); html = html.replace(INLINE.desk, () => `<style>${css}</style>`); }
  return html;
}
const template = () => readerPage('news.html');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// JSON inside <script>: no "</script>", no line separators that end a JS string
const LS = new RegExp(String.fromCharCode(0x2028), 'g'), PS = new RegExp(String.fromCharCode(0x2029), 'g');
const BS = String.fromCharCode(92); // a backslash, so "<" and the separators become JSON escape sequences
const scriptJson = (v) => JSON.stringify(v).replace(/</g, BS + 'u003c').replace(LS, BS + 'u2028').replace(PS, BS + 'u2029');
// The same as paragraphs() in news.html: a line is a paragraph, **…** is bold, [size=18]…[/size] a font size,
// [lh=loose] at the start its line spacing
const paragraphs = (t) => (t || '').split(/\n+/).map((p) => p.trim()).filter(Boolean)
  .map((p) => { const lh = p.match(/^\[lh=(tight|normal|loose)\]\s*/); return `<p${lh && lh[1] !== 'normal' ? ` data-leading="${lh[1]}"` : ''}>${esc(lh ? p.slice(lh[0].length) : p).replace(/\[size=(1[6-9]|20)\]([\s\S]*?)\[\/size\]/g, '<span data-size="$1">$2</span>').replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '<strong>$1</strong>')}</p>`; }).join('');
const clip = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const TH_DATE = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' });
const TH_TIME = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });

// Replaces `from` once; a template change that drops an anchor shows up as a page without that part, not an error
const swap = (html, from, to) => (html.includes(from) ? html.replace(from, to) : html);

function head(html, { title, description, url, image, type = 'website', robots, extra = '' }) {
  const tags = [
    `<link rel="canonical" href="${esc(url)}">`,
    robots ? `<meta name="robots" content="${robots}">` : '',
    `<meta property="og:site_name" content="${SITE}">`,
    '<meta property="og:locale" content="th_TH">',
    `<meta property="og:type" content="${type}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    extra,
  ].filter(Boolean).join('\n  ');
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)} | ${SITE}</title>`);
  html = html.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(description)}">\n  ${tags}`);
  return html;
}

export const router = Router();

router.get('/news.html', loadUser, async (req, res, next) => {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  let html = await template();
  res.set('Cache-Control', 'no-cache');
  if (!id) return res.type('html').send(html);
  let data;
  try {
    data = await storyPayload(req, id);
  } catch (err) {
    // The page script shows the right message from the API; crawlers get the status and noindex
    if (!err.status) return next(err);
    res.status(err.status === 401 || err.status === 403 ? 200 : err.status).set('X-Robots-Tag', 'noindex');
    return res.type('html').send(head(html, { title: err.status === 410 ? 'ข่าวนี้ถูกถอนแล้ว' : err.status === 404 ? 'ไม่พบข่าวนี้' : 'ข่าวภายใน',
      description: 'ข่าวสารของมหาวิทยาลัยราชภัฏสุราษฎร์ธานี', url: `${ORIGIN}/news.html?id=${encodeURIComponent(id)}`, image: ORIGIN + OG_DEFAULT, robots: 'noindex' }));
  }
  const { story: s, linked, linkedFromAlbum, related, sets, raw } = data;
  const url = `${ORIGIN}/news.html?id=${s.id}`;
  const lead = s.cover || s.gallery[0] || null;
  const image = lead ? ORIGIN + (lead.full || lead.web) : s.videoThumb ? ORIGIN + s.videoThumb : ORIGIN + OG_DEFAULT;
  const description = clip(s.lead || plainText(s.body) || `ข่าวจาก${s.unit}`, 200);
  const internal = s.internal;
  if (internal) res.set('X-Robots-Tag', 'noindex');
  const ld = {
    '@context': 'https://schema.org', '@type': 'NewsArticle', headline: clip(s.title, 110), description,
    image: [image], datePublished: new Date(s.publishedAt).toISOString(), dateModified: new Date(raw.updated_at || s.publishedAt).toISOString(),
    inLanguage: 'th', mainEntityOfPage: url,
    author: { '@type': 'Organization', name: s.unit },
    publisher: { '@type': 'Organization', name: 'งานประชาสัมพันธ์ มหาวิทยาลัยราชภัฏสุราษฎร์ธานี', logo: { '@type': 'ImageObject', url: `${ORIGIN}/assets/img/logo-192.webp` } },
  };
  const extra = [
    `<meta property="article:published_time" content="${new Date(s.publishedAt).toISOString()}">`,
    `<meta property="article:section" content="${esc(s.categories[0] || 'ข่าว')}">`,
    lead ? `<link rel="preload" as="image" href="${esc(lead.web)}"${lead.set ? ` imagesrcset="${esc(lead.set)}" imagesizes="(min-width: 1024px) 900px, 100vw"` : ''} fetchpriority="high">` : '',
    internal ? '' : `<script type="application/ld+json">${scriptJson(ld)}</script>`,
  ].filter(Boolean).join('\n  ');
  html = head(html, { title: s.title, description, url, image, type: 'article', robots: internal ? 'noindex' : '', extra });

  // The story in the markup: shown at once (no "loading" panel), the same elements the page script fills
  const at = new Date(s.publishedAt);
  html = swap(html, '<section id="state" class="', '<section id="state" hidden class="');
  html = swap(html, '<article id="article" lang="th" hidden>', '<article id="article" lang="th">');
  html = swap(html, 'data-i18n="title"></h1>', `data-i18n="title">${esc(s.title)}</h1>`);
  html = swap(html, 'data-i18n="dek"></p>', `data-i18n="dek"${s.lead ? '' : ' hidden'}>${esc(s.lead || '')}</p>`);
  html = swap(html, '<time id="pubTime" data-i18n="date"></time>', `<time id="pubTime" data-i18n="date" datetime="${at.toISOString()}">${TH_DATE.format(at)} · ${TH_TIME.format(at)} น.</time>`);
  html = swap(html, 'data-i18n="unit"></a>', `data-i18n="unit">${esc(s.unit)}</a>`);
  html = swap(html, 'data-i18n-html="body"></div>', `data-i18n-html="body"${s.bodySize ? ` data-size="${s.bodySize}"` : ''}${s.bodyLeading ? ` data-leading="${s.bodyLeading}"` : ''}>${paragraphs(s.body)}</div>`);
  if (lead) {
    html = swap(html, '<img id="leadImg" alt=""', `<img id="leadImg" alt="" src="${esc(lead.web)}"${lead.set ? ` srcset="${esc(lead.set)}" sizes="(min-width: 1024px) 900px, 100vw"` : ''} fetchpriority="high"`);
  } else {
    html = swap(html, '<figure id="leadFig" class="', '<figure id="leadFig" hidden class="');
  }
  // The data the page script would fetch from /api/news/:id
  html = swap(html, '<script>window.SERVER_AUTH = true;</script>', `<script>window.SERVER_AUTH = true; window.__NEWS = ${scriptJson({ story: s, linked, linkedFromAlbum, related, sets })};</script>`);
  res.type('html').send(html);
});

// search.html: the first page of results in the page (window.__SEARCH), so the cards and their pictures show without
// waiting for the script to ask the API. The query string is built exactly as the page script builds it (load() in
// search.html); the script uses the results only when its own query string is the same.
const BKK_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' });
function searchQuery(P) {
  const st = { q: P.get('q') || '', kind: P.get('kind') || '', cats: P.getAll('cat'), unit: P.get('unit') || '', range: P.get('range') || '',
    from: P.get('from') || '', to: P.get('to') || '', sort: P.get('sort') || 'relevance' };
  const now = new Date();
  const day = (d) => BKK_DAY.format(d);
  const d = st.range === '7' ? { from: day(new Date(now.getTime() - 6 * 86400000)), to: day(now) }
    : st.range === '30' ? { from: day(new Date(now.getTime() - 29 * 86400000)), to: day(now) }
      : st.range === 'year' ? { from: `${day(now).slice(0, 4)}-01-01`, to: day(now) }
        : st.range === 'custom' ? { from: st.from, to: st.to } : {};
  const p = new URLSearchParams({ limit: '12', offset: '0' });
  if (st.q) p.set('q', st.q);
  if (st.kind) p.set('kind', st.kind);
  st.cats.forEach((c) => p.append('cat', c));
  if (st.unit) p.set('unit', st.unit);
  if (d.from) p.set('from', d.from);
  if (d.to) p.set('to', d.to);
  if (st.q) p.set('sort', st.sort);
  return p;
}
router.get('/search.html', loadUser, async (req, res, next) => {
  const html = await readerPage('search.html');
  const p = searchQuery(new URLSearchParams(req.originalUrl.split('?')[1] || ''));
  const qs = {};
  for (const [k, v] of p) qs[k] = k === 'cat' ? [...(qs.cat || []), v] : v;
  let result;
  try { result = await searchPayload(qs, req.user); } catch (err) { return next(err); }
  res.set('Cache-Control', 'no-cache');
  // The first card's picture starts loading with the page (same srcset/sizes as the card in search.html)
  const first = result.items.find((n) => n.cover || n.videoThumb);
  const img = first?.cover && first.coverSet
    ? `<link rel="preload" as="image" href="${esc(first.cover)}" imagesrcset="${esc(first.coverSet)}" imagesizes="(min-width: 1024px) 300px, (min-width: 640px) 45vw, 100vw" fetchpriority="high">`
    : first ? `<link rel="preload" as="image" href="${esc(first.cover || first.videoThumb)}" fetchpriority="high">` : '';
  let page = img ? html.replace('</head>', `  ${img}\n</head>`) : html;
  // Show at once what the script would show (a unit page: the unit banner; otherwise the big search box),
  // so the results do not jump down when it does
  const P = new URLSearchParams(req.originalUrl.split('?')[1] || '');
  page = P.get('unit') && !P.get('q')
    ? swap(page, '<section id="unitHead" class="', '<section id="unitHead" data-ssr class="').replace(/(<section id="unitHead" data-ssr [^>]*?) hidden/, '$1')
    : swap(page, '<form id="bigSearch" role="search" action="search.html" hidden>', '<form id="bigSearch" role="search" action="search.html">');
  // ...and the filter bar and the result heading as the script sets them (paint() and load() in search.html): on a phone
  // "ล้างตัวกรอง" and "เรียงตาม" each wrap to a new line, which pushed the results down once the script ran
  const q = P.get('q') || '', unitPage = P.get('unit') && !q;
  if (q || P.get('kind') || P.getAll('cat').length || P.get('range') || (P.get('unit') && !unitPage)) page = page.replace(/(<button id="clear"[^>]*?) hidden>/, '$1>');
  if (q) page = page.replace(/(<label id="sortBox"[^>]*?) hidden>/, '$1>');
  const title = q ? `ผลการค้นหา “${esc(q)}”` : unitPage ? 'ข่าวทั้งหมดของหน่วยงาน' : 'ข่าวทั้งหมด';
  page = page.replace(/(<h2 id="resultTitle"[^>]*>)[^<]*</, (m, open) => `${open}${title}<`) // (functions: the search words may hold "$")
    .replace(/(<p id="resultCount"[^>]*>)[^<]*</, (m, open) => `${open}${result.total ? `พบ ${result.total.toLocaleString('th-TH')} ข่าว` : ''}<`);
  res.type('html').send(swap(page, '<script>window.SERVER_AUTH = true;</script>',
    `<script>window.SERVER_AUTH = true; window.__SEARCH = ${scriptJson({ query: p.toString(), result })};</script>`));
});

// The other reader pages: CSS in the page, nothing else changes
for (const [route, rel] of [['/', 'index.html'], ['/index.html', 'index.html'], ['/privacy.html', 'privacy.html'], ['/contact.html', 'contact.html']]) {
  router.get(route, async (req, res) => { res.set('Cache-Control', 'no-cache').type('html').send(await readerPage(rel)); });
}

// The page's old name, for links in old emails and bookmarks; the browser keeps the #section across the redirect
router.get('/admin.html', (req, res) => {
  const i = req.originalUrl.indexOf('?');
  res.redirect(301, `/chanon.html${i < 0 ? '' : req.originalUrl.slice(i)}`);
});

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').set('Cache-Control', 'public, max-age=86400').send([
    'User-agent: *',
    'Disallow: /api/',
    ...[...PRIVATE_PAGES].filter((p) => !['404.html', 'status.html', 'maintenance.html'].includes(p)).map((p) => `Disallow: /${p}`),
    '',
    `Sitemap: ${ORIGIN}/sitemap.xml`,
    '',
  ].join('\n'));
});

router.get('/sitemap.xml', async (req, res) => {
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  const stories = (await query(`select n.id, coalesce(n.updated_at, n.published_at) at from news n where ${LIVE} and 'public' = any(n.audience)
    order by n.published_at desc limit 45000`)).rows;
  const latest = stories[0]?.at || new Date();
  /** @type {{ loc: string, lastmod?: string, freq?: string }[]} */
  const urls = [
    { loc: `${ORIGIN}/`, lastmod: day(latest), freq: 'hourly' },
    { loc: `${ORIGIN}/search.html`, lastmod: day(latest), freq: 'daily' },
    { loc: `${ORIGIN}/privacy.html`, freq: 'yearly' },
    { loc: `${ORIGIN}/contact.html`, freq: 'monthly' },
    ...stories.map((n) => ({ loc: `${ORIGIN}/news.html?id=${n.id}`, lastmod: day(n.at) })),
  ];
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}${u.freq ? `<changefreq>${u.freq}</changefreq>` : ''}</url>`).join('\n')}
</urlset>
`);
});
