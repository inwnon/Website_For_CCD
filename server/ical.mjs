// iCal feeds (SPEC.md item 16, §7) for Google Calendar and other calendar apps: written by hand, no library, no paid API.
// - GET    /ical/public.ics            public events: title, time and place only (as /api/calendar/public)
// - GET    /ical/u/<token>.ics         one user's read-only feed: what the calendar shows them now, with their own duty;
//                                      never internal notes or other people's names. 404 once revoked or when the owner lost the calendar.
// - GET    /api/calendar/feed          { active, createdAt, lastUsedAt }: the link itself is never shown again
// - POST   /api/calendar/feed          a new link (the old one stops): { url }, shown once
// - DELETE /api/calendar/feed          revoke
// Only the SHA-256 of a token is stored (calendar_feeds).
import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { requireModule, rightOf } from './access.mjs';
import { audit } from './audit.mjs';
import { DEVELOPERS } from './auth.mjs';
import { one, query, tx } from './db.mjs';
import { ORIGIN } from './pages.mjs';
import { limit } from './security.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAST_DAYS = 60;
const AHEAD_DAYS = 400;
const MAX_EVENTS = 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HOST = new URL(ORIGIN).host;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const span = () => [new Date(Date.now() - PAST_DAYS * DAY_MS), new Date(Date.now() + AHEAD_DAYS * DAY_MS)];

// RFC 5545 §3.3.11 text, §3.1 lines of at most 75 octets (a continuation starts with a space), CRLF
const escape = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  const out = [];
  let cur = '', bytes = 0, max = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > max) { out.push(cur); cur = ' '; bytes = 1; max = 75; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}
const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** @param {string} name @param {{ id: string, title: string, location?: string, start_at: Date, end_at: Date, details?: string }[]} events */
function calendar(name, events) {
  const now = stamp(new Date());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SRU Corporate Communication//Calendar//TH', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${escape(name)}`, 'X-WR-TIMEZONE:Asia/Bangkok', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const e of events) {
    // The UID is stable but does not reveal the event's id
    lines.push('BEGIN:VEVENT', `UID:${sha256(`event:${e.id}`).slice(0, 32)}@${HOST}`, `DTSTAMP:${now}`, `DTSTART:${stamp(e.start_at)}`, `DTEND:${stamp(e.end_at)}`,
      `SUMMARY:${escape(e.title)}`);
    if (e.location) lines.push(`LOCATION:${escape(e.location)}`);
    if (e.details) lines.push(`DESCRIPTION:${escape(e.details)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
const send = (res, body, cache) => res.type('text/calendar; charset=utf-8').set({ 'Cache-Control': cache, 'X-Robots-Tag': 'noindex' }).send(body);
const notFound = (res) => res.status(404).type('text/plain; charset=utf-8').set('Cache-Control', 'no-store').send('ไม่พบปฏิทินนี้');

// ---- Feeds (no cookie: calendar apps fetch them on their own) ----
export const feeds = Router();
feeds.use(limit('ical', { max: 120, windowMs: 10 * 60 * 1000, by: 'ip' }));

feeds.get('/public.ics', async (req, res) => {
  const rows = (await query(`select id, title, location, start_at, end_at from events
    where visibility = 'public' and status = 'scheduled' and end_at >= $1 and start_at < $2 order by start_at limit ${MAX_EVENTS}`, span())).rows;
  send(res, calendar('ปฏิทินกิจกรรม มรส.', rows), 'public, max-age=900');
});

feeds.get('/u/:file', async (req, res) => {
  const token = req.params.file.replace(/\.ics$/, '');
  if (!req.params.file.endsWith('.ics') || !TOKEN.test(token)) return notFound(res);
  const user = await one(`select u.* from calendar_feeds f join users u on u.id = f.user_id where f.token_hash = $1 and u.erased_at is null`, [sha256(token)]);
  if (user && DEVELOPERS.has(user.email)) user.role = 'admin';
  const right = rightOf(user, 'calendar');
  if (!right) return notFound(res);
  const [from, to] = span();
  const rows = (await query(`select e.id, e.title, e.location, e.start_at, e.end_at, e.description, a.duty from events e
      left join event_assignments a on a.event_id = e.id and a.user_id = $3
    where e.status = 'scheduled' and e.end_at >= $1 and e.start_at < $2 and ($4::boolean is false or a.user_id is not null)
    order by e.start_at limit ${MAX_EVENTS}`, [from, to, user.id, right === 'own'])).rows;
  await query(`update calendar_feeds set last_used_at = now() where user_id = $1 and (last_used_at is null or last_used_at < now() - interval '10 minutes')`, [user.id]);
  const items = rows.map((e) => ({ ...e, details: [e.duty && `หน้าที่ของคุณ: ${e.duty}`, e.description].filter(Boolean).join('\n\n') }));
  send(res, calendar('ปฏิทินงาน มรส.', items), 'private, no-store');
});

// ---- Managing one's own link (/api) ----
export const router = Router();
const owner = requireModule('calendar');

router.get('/calendar/feed', owner, async (req, res) => {
  const f = await one('select created_at, last_used_at from calendar_feeds where user_id = $1', [req.user.id]);
  res.json({ active: !!f, createdAt: f?.created_at ?? null, lastUsedAt: f?.last_used_at ?? null, publicUrl: `${ORIGIN}/ical/public.ics` });
});

router.post('/calendar/feed', owner, limit('ical-new', { max: 10, windowMs: 10 * 60 * 1000 }), async (req, res) => {
  const token = randomBytes(32).toString('base64url');
  await tx(async (c) => {
    await c.query(`insert into calendar_feeds (user_id, token_hash) values ($1, $2)
      on conflict (user_id) do update set token_hash = $2, created_at = now(), last_used_at = null`, [req.user.id, sha256(token)]);
    await audit(c, req.user, 'calendar.feed.create', req.user.id, 'สร้างลิงก์ปฏิทินส่วนตัวใหม่ (ลิงก์เดิมใช้ไม่ได้แล้ว)');
  });
  res.status(201).json({ url: `${ORIGIN}/ical/u/${token}.ics` });
});

router.delete('/calendar/feed', owner, async (req, res) => {
  await tx(async (c) => {
    const { rowCount } = await c.query('delete from calendar_feeds where user_id = $1', [req.user.id]);
    if (rowCount) await audit(c, req.user, 'calendar.feed.revoke', req.user.id, 'ยกเลิกลิงก์ปฏิทินส่วนตัว');
  });
  res.json({ active: false });
});
