// Email notifications (phase 9)
// - enqueue(db, mail) inside the transaction of the change it reports → email_outbox row
// - worker: sends queued rows every 30 s over SMTP (.env SMTP_*); without SMTP rows become 'skipped'
// - daily(): the 08:00 Bangkok summary for the PR team
// - GET/PUT /api/me/notify   what the signed-in user wants by email
// - GET /api/admin/mail · POST /api/admin/mail/test   outbox and a test email (chanon.html)
// - GET /api/notifications · POST /api/notifications/:id/read · POST /api/notifications/read-all   in-app notices (calendar events)
import { Router } from 'express';
import nodemailer from 'nodemailer';
import { requireBackOffice, rightOf } from './access.mjs';
import { audit } from './audit.mjs';
import { isPr, requireAdmin, requireUser } from './auth.mjs';
import { one, pool, query, tx } from './db.mjs';
import { HttpError } from './http.mjs';
import { get } from './settings.mjs';
import { limit } from './security.mjs';

const ORIGIN = (process.env.APP_ORIGIN || 'http://localhost:3000').replace(/\/$/, '');
const FROM = process.env.MAIL_FROM || 'คลังข่าว มรส. <no-reply@sru.ac.th>';
export const SMTP = !!process.env.SMTP_HOST;
const transport = SMTP ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === '1',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
}) : null;

// Settings a user can turn off (missing = on). PR keys only matter for the PR team.
export const PREFS = {
  status: 'เมื่องานที่ส่งเปลี่ยนสถานะ (ขอแก้ไข เผยแพร่)',
  message: 'เมื่อทีม PR ส่งข้อความถึงคุณ',
  assign: 'เมื่อได้รับมอบหมายงานในปฏิทิน งานถูกยกเลิก และเตือนก่อนวันงาน 1 วัน',
  prNew: 'ทีม PR: เมื่อมีงานใหม่ งานที่แก้ไขแล้ว หรือข้อความจากผู้ส่ง',
  prDaily: 'ทีม PR: สรุปงานค้างตรวจและเล่มที่รออนุมัติทุกเช้า 08:00 น.',
};
const wants = (notify, key) => (notify || {})[key] !== false;
export const link = (path) => `${ORIGIN}/${path.replace(/^\//, '')}`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// One layout for every email: heading, paragraphs, an optional quote, one button
/** @param {{ title?: string, lines?: string[], quote?: string, button?: { label: string, href: string } }} content */
function render({ title, lines = [], quote, button }) {
  const text = [title, '', ...lines, ...(quote ? ['', `“${quote}”`] : []), ...(button ? ['', `${button.label}: ${button.href}`] : []),
    '', '—', 'คลังข่าว มรส. งานประชาสัมพันธ์ มหาวิทยาลัยราชภัฏสุราษฎร์ธานี', `ตั้งค่าการแจ้งเตือน: ${link('inbox.html#notify')}`].join('\n');
  const html = `<!doctype html><html lang="th"><body style="margin:0;background:#F5F4FF;font-family:'Noto Sans Thai',Tahoma,sans-serif;color:#1B2560">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <p style="margin:0 0 12px;font-size:15px;font-weight:700"><span style="color:#DE142A">ข่าว</span> <span style="color:#2642C8">มรส.</span></p>
    <div style="background:#fff;border-radius:20px;padding:24px;box-shadow:0 1px 2px rgba(27,37,96,.06),0 8px 24px rgba(27,37,96,.08)">
      <h1 style="margin:0 0 12px;font-size:20px;line-height:1.4;color:#2642C8">${esc(title)}</h1>
      ${lines.map((l) => `<p style="margin:0 0 10px;font-size:15px;line-height:1.7">${esc(l)}</p>`).join('')}
      ${quote ? `<blockquote style="margin:12px 0;padding:12px 16px;background:#F5F4FF;border-radius:14px;font-size:15px;line-height:1.7;white-space:pre-line">${esc(quote)}</blockquote>` : ''}
      ${button ? `<p style="margin:20px 0 0"><a href="${esc(button.href)}" style="display:inline-block;padding:12px 22px;border-radius:14px;background:#DE142A;background-image:linear-gradient(100deg,#DE142A,#7A3CE2);color:#fff;font-weight:700;text-decoration:none">${esc(button.label)}</a></p>` : ''}
    </div>
    <p style="margin:16px 4px 0;font-size:12px;line-height:1.6;color:#5C6694">งานประชาสัมพันธ์ มหาวิทยาลัยราชภัฏสุราษฎร์ธานี · <a href="${link('inbox.html#notify')}" style="color:#5C6694">ตั้งค่าการแจ้งเตือน</a></p>
  </div></body></html>`;
  return { text, html };
}

export async function enqueue(db, { kind, ref = null, to, subject, ...content }) {
  if (!to) return;
  const { text, html } = render(content);
  await (db || pool).query('insert into email_outbox (kind, ref, to_email, subject, body, html) values ($1, $2, $3, $4, $5, $6)',
    [kind, ref, to.toLowerCase(), `[คลังข่าว มรส.] ${subject}`, text, html]);
}

// The PR team (pr / admin), with what each wants
async function prTeam(db, key) {
  const rows = (await (db || pool).query(`select t.email, u.notify from pr_team t left join users u on u.email = t.email where t.role in ('pr', 'admin')`)).rows;
  return rows.filter((r) => wants(r.notify, key)).map((r) => r.email);
}

// ---- Events (called from submissions.mjs and pr.mjs inside their transactions) ----
const STATUS_MAIL = {
  revise: { subject: (s) => `ขอให้แก้ไขงาน ${s.ref}`, title: 'งานประชาสัมพันธ์ขอให้แก้ไขงานของคุณ', button: 'เปิดงานเพื่อแก้ไข', path: (s) => `submit.html?edit=${encodeURIComponent(s.ref)}` },
  writing: { subject: (s) => `ทีม PR กำลังเขียนข่าว ${s.ref}`, title: 'ทีม PR กำลังเขียนข่าวจากเอกสารของคุณ', button: 'ดูสถานะงาน' },
  review: { subject: (s) => `งาน ${s.ref} กลับมารอตรวจ`, title: 'งานของคุณกลับมาอยู่ในคิวรอตรวจ', button: 'ดูสถานะงาน' },
  published: { subject: (s) => `เผยแพร่แล้ว: ${s.title}`, title: 'งานของคุณเผยแพร่บนเว็บไซต์แล้ว', button: 'อ่านข่าวที่เผยแพร่' },
};
export async function statusChanged(db, s, status, message, newsId) {
  const m = STATUS_MAIL[status];
  const u = (await db.query('select email, name, notify from users where id = $1', [s.sender_id])).rows[0];
  if (!m || !u || !wants(u.notify, 'status')) return;
  const path = status === 'published' && newsId ? `news.html?id=${newsId}` : m.path ? m.path(s) : `inbox.html?ref=${encodeURIComponent(s.ref)}`;
  await enqueue(db, {
    kind: 'submission.status', ref: s.ref, to: u.email, subject: m.subject(s), title: m.title,
    lines: [`${s.ref} · ${s.title}`, `หน่วยงาน ${s.unit}`], quote: message || undefined, button: { label: m.button, href: link(path) },
  });
}
export async function prMessaged(db, s, text) {
  const u = (await db.query('select email, notify from users where id = $1', [s.sender_id])).rows[0];
  if (!u || !wants(u.notify, 'message')) return;
  await enqueue(db, {
    kind: 'submission.message', ref: s.ref, to: u.email, subject: `ข้อความใหม่จากทีม PR: ${s.ref}`, title: 'ทีม PR ส่งข้อความถึงคุณ',
    lines: [`${s.ref} · ${s.title}`], quote: text, button: { label: 'ตอบกลับในหน้าข่าวของฉัน', href: link(`inbox.html?ref=${encodeURIComponent(s.ref)}`) },
  });
}
const PR_MAIL = {
  'pr.new': (s, who) => ({ subject: `งานใหม่ ${s.ref}: ${s.title}`, title: 'มีงานใหม่ส่งเข้ามา', lines: [`${s.ref} · ${s.title}`, `จาก ${who} · ${s.unit}`] }),
  'pr.resent': (s, who) => ({ subject: `ผู้ส่งแก้ไขงาน ${s.ref} แล้ว`, title: 'ผู้ส่งแก้ไขงานแล้ว รอตรวจอีกครั้ง', lines: [`${s.ref} · ${s.title}`, `จาก ${who} · ${s.unit}`] }),
  'pr.message': (s, who) => ({ subject: `ข้อความจากผู้ส่ง ${s.ref}`, title: `${who} ส่งข้อความถึงทีม PR`, lines: [`${s.ref} · ${s.title}`] }),
};
export async function toPrTeam(db, kind, s, user, quote) {
  const who = user.name || user.email;
  const m = PR_MAIL[kind](s, who);
  for (const to of await prTeam(db, 'prNew')) {
    if (to === user.email) continue;
    await enqueue(db, { kind, ref: s.ref, to, ...m, quote, button: { label: 'เปิดงานในหน้าทีม PR', href: link(`pr.html?ref=${encodeURIComponent(s.ref)}`) } });
  }
}

// ---- Calendar (called from calendar.mjs inside its transactions): an in-app notice, and an email unless turned off ----
const WHEN = new Intl.DateTimeFormat('th-TH', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
async function tell(db, u, kind, e, text, title, duty) {
  await db.query('insert into notifications (user_id, kind, ref_id, text) values ($1, $2, $3, $4)', [u.id, kind, e.id, text]);
  if (!wants(u.notify, 'assign')) return;
  const lines = [e.title, `${WHEN.format(e.start_at)} น.`, ...(e.location ? [`สถานที่ ${e.location}`] : []), ...(duty ? [`หน้าที่ของคุณ ${duty}`] : [])];
  await enqueue(db, { kind, ref: e.id, to: u.email, subject: text, title, lines, button: { label: 'เปิดปฏิทินงาน', href: link(`calendar.html?id=${e.id}`) } });
}
export async function eventAssigned(db, e, userIds) {
  if (!userIds.length) return;
  const rows = (await db.query(`select u.id, u.email, u.notify, a.duty from event_assignments a join users u on u.id = a.user_id
    where a.event_id = $1 and a.user_id = any($2)`, [e.id, userIds])).rows;
  for (const u of rows) await tell(db, u, 'event.assigned', e, `คุณได้รับมอบหมายงาน: ${e.title}`, 'คุณได้รับมอบหมายงานใหม่', u.duty);
}
export async function eventCancelled(db, e) {
  const rows = (await db.query('select u.id, u.email, u.notify from event_assignments a join users u on u.id = a.user_id where a.event_id = $1', [e.id])).rows;
  for (const u of rows) await tell(db, u, 'event.cancelled', e, `ยกเลิกงาน: ${e.title}`, 'งานที่คุณได้รับมอบหมายถูกยกเลิก');
}
// Events that start tomorrow (Bangkok), each person once; reminded_at is cleared when the event moves
export async function eventReminders() {
  await tx(async (c) => {
    const rows = (await c.query(`update event_assignments a set reminded_at = now() from events e, users u
      where e.id = a.event_id and u.id = a.user_id and a.reminded_at is null and e.status = 'scheduled'
        and (e.start_at at time zone 'Asia/Bangkok')::date = (now() at time zone 'Asia/Bangkok')::date + 1
      returning e.id, e.title, e.location, e.start_at, a.duty, u.id user_id, u.email, u.notify`)).rows;
    for (const r of rows) await tell(c, { id: r.user_id, email: r.email, notify: r.notify }, 'event.reminder', r, `พรุ่งนี้มีงาน: ${r.title}`, 'พรุ่งนี้คุณมีงาน', r.duty);
  });
}

// ---- Daily summary (08:00 Bangkok) ----
export async function daily() {
  await eventReminders();
  const days = get('review').days;
  const queue = (await query(`select s.ref, s.title, s.unit, s.status, s.sent_at,
      (select count(*)::int - 1 from generate_series(s.sent_at::date, now()::date, '1 day') d where extract(isodow from d) < 6) work_days
    from submissions s where s.status in ('review', 'writing') order by s.sent_at`)).rows;
  const late = queue.filter((r) => r.work_days > days);
  const team = await prTeam(null, 'prDaily');
  if (queue.length) {
    const lines = [
      `งานรอตรวจ ${queue.filter((r) => r.status === 'review').length} งาน · PR กำลังเขียน ${queue.filter((r) => r.status === 'writing').length} งาน`,
      late.length ? `เกินเวลาตรวจ ${days} วันทำการ ${late.length} งาน: ${late.slice(0, 5).map((r) => r.ref).join(', ')}${late.length > 5 ? ' …' : ''}` : `ไม่มีงานที่เกินเวลาตรวจ ${days} วันทำการ`,
      ...(queue[0] ? [`งานที่รอนานที่สุด ${queue[0].ref} (${queue[0].work_days} วันทำการ)`] : []),
    ];
    for (const to of team) {
      await enqueue(null, { kind: 'pr.daily', to, subject: late.length ? `งานเกินเวลาตรวจ ${late.length} งาน` : 'สรุปงานเช้านี้', title: 'สรุปงานของทีม PR เช้านี้', lines, button: { label: 'เปิดหน้างานที่ส่งเข้ามา', href: link('pr.html') } });
    }
  }
}
// Runs daily() once per Bangkok day, from 08:00
export async function dailyIfDue() {
  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Bangkok' }).format(now));
  if (hour < 8) return false;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(now);
  const claimed = await one(`insert into job_runs (name, last_day) values ('daily', $1) on conflict (name) do update set last_day = $1
    where job_runs.last_day < $1 returning name`, [day]);
  if (!claimed) return false;
  await daily();
  return true;
}

// ---- Sending ----
let sending = false;
export async function sendQueued() {
  if (sending) return;
  sending = true;
  try {
    const rows = (await query(`select * from email_outbox where status = 'queued' order by id limit 20`)).rows;
    for (const r of rows) {
      if (!transport) { await query(`update email_outbox set status = 'skipped', error = 'ยังไม่ได้ตั้งค่า SMTP' where id = $1`, [r.id]); continue; }
      try {
        await transport.sendMail({ from: FROM, to: r.to_email, subject: r.subject, text: r.body, html: r.html });
        await query(`update email_outbox set status = 'sent', sent_at = now(), tries = tries + 1, error = null where id = $1`, [r.id]);
      } catch (err) {
        await query(`update email_outbox set tries = tries + 1, error = $2, status = case when tries + 1 >= 3 then 'failed' else 'queued' end where id = $1`, [r.id, String(err.message).slice(0, 500)]);
      }
    }
  } finally {
    sending = false;
  }
}

// ---- Routes ----
export const router = Router();
const mailTest = limit('mailTest', { max: 10, windowMs: 10 * 60 * 1000 });

router.get('/me/notify', requireUser, (req, res) => {
  const keys = isPr(req.user) ? Object.keys(PREFS) : ['status', 'message', ...(rightOf(req.user, 'calendar') === 'own' ? ['assign'] : [])];
  res.json({ email: req.user.email, smtp: SMTP, prefs: keys.map((k) => ({ key: k, label: PREFS[k], on: wants(req.user.notify, k) })) });
});
router.put('/me/notify', requireUser, async (req, res) => {
  const b = req.body || {};
  const next = { ...(req.user.notify || {}) };
  for (const k of Object.keys(PREFS)) if (typeof b[k] === 'boolean') next[k] = b[k];
  await query('update users set notify = $2 where id = $1', [req.user.id, JSON.stringify(next)]);
  res.json({ ok: true, notify: next });
});

router.get('/notifications', requireBackOffice, async (req, res) => {
  const rows = (await query('select id, kind, ref_id, text, read_at, created_at from notifications where user_id = $1 order by id desc limit 50', [req.user.id])).rows;
  const { n } = await one('select count(*)::int n from notifications where user_id = $1 and read_at is null', [req.user.id]);
  res.json({ unread: n, items: rows.map((r) => ({ id: r.id, kind: r.kind, refId: r.ref_id, text: r.text, readAt: r.read_at, createdAt: r.created_at })) });
});
router.post('/notifications/read-all', requireBackOffice, async (req, res) => {
  await query('update notifications set read_at = now() where user_id = $1 and read_at is null', [req.user.id]);
  res.json({ ok: true });
});
router.post('/notifications/:id/read', requireBackOffice, async (req, res) => {
  if (!/^\d{1,18}$/.test(req.params.id)) throw new HttpError(404, 'ไม่พบการแจ้งเตือนนี้');
  const r = await one('update notifications set read_at = coalesce(read_at, now()) where id = $1 and user_id = $2 returning id', [req.params.id, req.user.id]);
  if (!r) throw new HttpError(404, 'ไม่พบการแจ้งเตือนนี้');
  res.json({ ok: true });
});

router.get('/admin/mail', requireAdmin, async (req, res) => {
  const items = (await query('select id, created_at, kind, ref, to_email, subject, status, error, sent_at from email_outbox order by id desc limit 100')).rows;
  const counts = (await query(`select status, count(*)::int n from email_outbox where created_at > now() - interval '7 days' group by 1`)).rows;
  res.json({ smtp: SMTP, from: FROM, items, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) });
});
router.get('/admin/mail/:id', requireAdmin, async (req, res) => {
  const r = await one('select * from email_outbox where id = $1', [Number(req.params.id) || 0]);
  if (!r) throw new HttpError(404, 'ไม่พบอีเมลนี้');
  res.json({ mail: r });
});
router.post('/admin/mail/test', requireAdmin, mailTest, async (req, res) => {
  await enqueue(null, {
    kind: 'test', to: req.user.email, subject: 'อีเมลทดสอบ', title: 'อีเมลทดสอบจากระบบคลังข่าว มรส.',
    lines: [SMTP ? 'ถ้าคุณได้รับอีเมลนี้ แปลว่าการตั้งค่า SMTP ใช้งานได้' : 'ยังไม่ได้ตั้งค่า SMTP อีเมลนี้จึงบันทึกไว้ในระบบเท่านั้น'],
    button: { label: 'เปิดหน้าตั้งค่าระบบ', href: link('chanon.html#mail') },
  });
  await audit(null, req.user, 'mail.test', req.user.email, `ส่งอีเมลทดสอบถึง ${req.user.email}`);
  sendQueued().catch(() => {});
  res.status(201).json({ ok: true });
});
