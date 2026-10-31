// App server: the pages + /api on one port.  npm run dev → http://localhost:3000
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import compression from 'compression';
import express from 'express';
import { router as adminRouter } from './admin.mjs';
import { loadUser, router as authRouter } from './auth.mjs';
import { query, registerEnumArrays } from './db.mjs';
import { errorHandler, sameOrigin } from './http.mjs';
import { media, router as newsRouter } from './news.mjs';
import { router as newsdeskRouter } from './newsdesk.mjs';
import { noindex, router as pagesRouter } from './pages.mjs';
import { ORG, ORG_HELPERS } from './org.mjs';
import { router as reportsRouter } from './reports.mjs';
import { get as setting, load as loadSettings, publicSite } from './settings.mjs';
import { router as prRouter } from './pr.mjs';
import { router as submissionsRouter } from './submissions.mjs';
import { router as draftsRouter } from './drafts.mjs';
import { router as contactRouter } from './contact.mjs';
import { router as collectionsRouter } from './collections.mjs';
import { router as calendarRouter } from './calendar.mjs';
import { dailyIfDue, router as notifyRouter, sendQueued } from './notify.mjs';
import { purge, router as privacyRouter } from './privacy.mjs';
import { httpsOnly, productionProblems, headers as securityHeaders } from './security.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const ORIGIN = process.env.APP_ORIGIN || `http://localhost:${PORT}`;

const PROD = process.env.NODE_ENV === 'production';
// Production starts only with safe settings (security.mjs)
if (PROD) {
  const problems = productionProblems(process.env);
  if (problems.length) {
    console.error(['คลังข่าว มรส. ไม่เริ่มทำงาน: ตั้งค่าใน .env ให้ถูกต้องก่อน', ...problems.map((p) => `  - ${p}`)].join('\n'));
    process.exit(1);
  }
}

const app = express();
app.disable('x-powered-by');
// Behind the university's reverse proxy: which proxy to believe for X-Forwarded-Proto / -For
// (loopback = a proxy on this machine; set TRUST_PROXY to its address when it runs elsewhere)
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
// Every page over HTTPS in production (HSTS is sent with HTTPS responses, security.mjs)
if (PROD) app.use(httpsOnly(ORIGIN));

// CSP, HSTS (over HTTPS) and the other security headers (security.mjs)
app.use(securityHeaders);
// gzip for pages, CSS, scripts and JSON (images and fonts are already compressed; compression skips them)
app.use(compression());

// ---- API ----
const api = express.Router();
api.use(express.json({ limit: '1mb' }));
api.use(sameOrigin(ORIGIN));
api.use(loadUser);
api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
api.use(authRouter);
api.use(newsRouter);
api.use(collectionsRouter);
api.use(calendarRouter);
api.use(submissionsRouter);
api.use(draftsRouter);
api.use(prRouter);
api.use(newsdeskRouter);
api.use(reportsRouter);
api.use(adminRouter);
api.use(notifyRouter);
api.use(privacyRouter);
api.use(contactRouter);
api.use((req, res) => res.status(404).json({ error: 'ไม่พบ API นี้' }));
app.use('/api', api);

// ---- Pages ----
// Only the site's own files are public: top-level pages/scripts and brand_assets/.
// server/, uploads/, node_modules/, .env etc. are never served.
const PUBLIC_FILE = /^\/[\w.-]+\.(html|js|css|png|jpe?g|webp|svg|ico|woff2)$/;
// Images of published stories (copied out of submissions when PR publishes); internal stories need sign-in
app.use('/media', loadUser, media);
app.use('/brand_assets', express.static(join(ROOT, 'brand_assets')));
// Built CSS and the self-hosted fonts (npm run build:css). app.css is linked with ?v=<hash>, so both cache for good.
app.use('/assets/src', (req, res) => res.status(404).end());
app.use('/assets', express.static(join(ROOT, 'assets'), { index: false, immutable: true, maxAge: '365d', fallthrough: false }));
// Settings the pages need (admin.html): window.SITE, and the org chart when admin has edited it
app.get('/site-config.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-cache').send(`window.SITE = ${JSON.stringify(publicSite())};\n`);
});
app.get('/org-data.js', (req, res, next) => {
  if (!setting('org')) return next(); // the file itself
  const data = { staffGroups: ORG.staffGroups, subUnits: ORG.subUnits, faculties: ORG.faculties };
  res.type('application/javascript').set('Cache-Control', 'no-cache').send(`// Org chart saved on admin.html\nwindow.ORG = ${JSON.stringify(data, null, 2)};\n\n${ORG_HELPERS}`);
});
// news.html with the story in it, sitemap.xml, robots.txt (pages.mjs); sign-in and back-office pages are noindex
app.use(pagesRouter);
app.use(noindex);
app.get('/', (req, res) => res.sendFile(join(ROOT, 'index.html')));
app.get(/^\/[^/]+$/, (req, res, next) => {
  if (!PUBLIC_FILE.test(req.path)) return next();
  const file = join(ROOT, req.path);
  if (!existsSync(file)) return next();
  res.sendFile(file, { dotfiles: 'deny' });
});
// Unknown pages: the 404 page for browsers, plain text for anything else
app.use((req, res) => {
  if (req.method === 'GET' && req.accepts('html')) return res.status(404).sendFile(join(ROOT, '404.html'));
  res.status(404).type('text/plain; charset=utf-8').send('Not found');
});
app.use(errorHandler);

// ---- Housekeeping ----
async function hourly() {
  try {
    await query('delete from sessions where expires_at < now()');
    // Single reads are kept 90 days; the daily totals (news_reads_daily) stay
    await query("delete from news_reads where at < now() - interval '90 days'");
    await dailyIfDue();
    // PDPA: files of work that was never published, after the retention period
    await purge();
  } catch (err) {
    console.error('housekeeping failed:', err.message);
  }
}
setInterval(hourly, 60 * 60 * 1000).unref();
// Emails waiting in the outbox
setInterval(() => sendQueued().catch((err) => console.error('mail:', err.message)), 30 * 1000).unref();

await registerEnumArrays();
await loadSettings();
hourly();
// Production listens on this machine only (the reverse proxy is the way in); the Docker image sets HOST=0.0.0.0
const HOST = process.env.HOST || (PROD ? '127.0.0.1' : undefined);
app.listen(PORT, HOST, () => console.log(`คลังข่าว มรส. → ${ORIGIN}${HOST ? ` (listening on ${HOST}:${PORT})` : ''}`));
