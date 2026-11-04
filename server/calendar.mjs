// ปฏิทินงาน (SPEC.md Phase 1, rights in access.mjs): events on calendar.html and index.html, the people assigned to them, and the public feed.
// - GET  /api/calendar/public?from=&to=        public events: title, startAt, endAt, location and nothing else (index.html)
// - GET  /api/calendar/events?from=&to=        the events the user may see; dates are YYYY-MM-DD, Bangkok days, both included
// - GET  /api/calendar/events/:id
// - POST /api/calendar/events                  { title, type, location, startAt, endAt, visibility, description, internalNote, assignees: [{ userId, duty }] }
// - PUT  /api/calendar/events/:id              the same fields
// - POST /api/calendar/events/:id/cancel       the row stays, marked cancelled
// - GET  /api/calendar/people?q=               who can be assigned
// - POST   /api/calendar/events/:id/banners    multipart, one picture in field "file" (JPG, PNG or WebP, 10 MB); at most 2 per event
// - DELETE /api/calendar/events/:id/banners/:bannerId
// - GET    /api/calendar/banners/:bannerId     the picture: anyone for a public scheduled event, otherwise whoever may see the event
// A student sees only the events they are on. internal_note is for PR and admin; cancelled events too, in the list.
// PR and admin change every event, a secretary only those they created.
import { extname, join } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { requireModule, rightOf } from './access.mjs';
import { audit } from './audit.mjs';
import { one, query, tx } from './db.mjs';
import { UPLOAD_DIR, removeStored, removeTemp, sendMedia, storeBanner } from './files.mjs';
import { HttpError, str } from './http.mjs';
import { eventAssigned, eventCancelled } from './notify.mjs';
import { limit, matchesName } from './security.mjs';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const TYPES = ['meeting', 'activity', 'media', 'other'];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 400;
const MAX_ASSIGNEES = 30;
const MAX_BANNERS = 2;
const MB = 1024 * 1024;
const MAX_BANNER = 10 * MB;
const BANNER_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

const edits = (right) => right === 'all' || right === 'edit';
// A secretary adds events and changes only those they made; internal notes stay with PR and admin
const manages = (right, e, userId) => edits(right) || (right === 'create' && e.created_by === userId);
const assignable = (u) => ['all', 'edit', 'own'].includes(rightOf(u, 'calendar'));
const writer = requireModule('calendar', 'all', 'edit', 'create');
const upload = multer({ dest: join(UPLOAD_DIR, 'tmp'), limits: { fileSize: MAX_BANNER, files: 1, fields: 0 }, defParamCharset: 'utf8' }).single('file');
const uploads = limit('event-banners', { max: 60, windowMs: 10 * 60 * 1000 });

export const router = Router();

// A real calendar day (Date would turn 31 February into March) in Christian years, so a Buddhist-era year is refused
function realDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return y >= 2020 && y <= 2100 && new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d;
}
export const time = (v) => (typeof v === 'string' && TIME.test(v) && realDay(v.slice(0, 10)) && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);

function range(q) {
  const valid = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && realDay(s);
  if (!valid(q.from) || !valid(q.to)) throw new HttpError(400, 'เลือกช่วงวันที่ให้ถูกต้อง');
  const from = new Date(`${q.from}T00:00:00+07:00`);
  const to = new Date(new Date(`${q.to}T00:00:00+07:00`).getTime() + DAY_MS);
  if (to <= from || to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) throw new HttpError(400, 'เลือกช่วงวันที่ให้ถูกต้อง');
  return { from, to };
}

async function assigneesOf(ids) {
  const rows = (await query(`select a.event_id, a.user_id, a.duty, u.name from event_assignments a join users u on u.id = a.user_id
    where a.event_id = any($1) order by u.name`, [ids])).rows;
  return rows;
}
const bannersOf = async (ids) => (await query('select id, event_id from event_banners where event_id = any($1) order by created_at, id', [ids])).rows;
const bannerList = (banners, eventId) => banners.filter((b) => b.event_id === eventId).map((b) => ({ id: b.id, url: `/api/calendar/banners/${b.id}` }));
function eventOut(e, right, people, userId, banners) {
  const mine = people.find((p) => p.event_id === e.id && p.user_id === userId);
  const canEdit = manages(right, e, userId);
  return {
    id: e.id, title: e.title, type: e.type, location: e.location, startAt: e.start_at, endAt: e.end_at, status: e.status,
    visibility: e.visibility, description: e.description, myDuty: mine?.duty ?? null, canEdit, banners: bannerList(banners, e.id),
    assignees: people.filter((p) => p.event_id === e.id).map((p) => ({ ...(canEdit ? { id: p.user_id } : {}), name: p.name, duty: p.duty })),
    ...(edits(right) ? { internalNote: e.internal_note, createdAt: e.created_at, updatedAt: e.updated_at } : {}),
  };
}

// Throws 400 with a field → message map; assignees must exist and be people who work on events
export async function checkEvent(b) {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'ไม่พบข้อมูลกิจกรรม');
  const errors = {};
  const row = {
    title: str(b.title, 200, 'ชื่อกิจกรรม'), type: b.type, location: str(b.location, 200, 'สถานที่'), start: time(b.startAt), end: time(b.endAt),
    visibility: b.visibility ?? 'internal', description: str(b.description, 2000, 'รายละเอียด'), note: str(b.internalNote, 2000, 'โน้ตภายใน'),
  };
  if (!row.title) errors.title = 'กรอกชื่อกิจกรรม';
  if (!TYPES.includes(row.type)) errors.type = 'เลือกประเภทกิจกรรม';
  if (!['internal', 'public'].includes(row.visibility)) errors.visibility = 'เลือกว่าใครเห็นกิจกรรมนี้';
  if (!row.start) errors.startAt = 'เลือกวันเวลาเริ่ม';
  if (!row.end) errors.endAt = 'เลือกวันเวลาสิ้นสุด';
  if (row.start && row.end && row.end <= row.start) errors.endAt = 'เวลาสิ้นสุดต้องหลังเวลาเริ่ม';

  const list = Array.isArray(b.assignees) ? b.assignees : null;
  if (!list || list.length > MAX_ASSIGNEES) errors.assignees = `มอบหมายได้ไม่เกิน ${MAX_ASSIGNEES} คน`;
  const assignees = (list || []).map((a) => ({ userId: a?.userId, duty: str(a?.duty, 120, 'หน้าที่') }));
  if (assignees.some((a) => typeof a.userId !== 'string' || !UUID.test(a.userId))) errors.assignees = 'ไม่พบบางคนที่เลือก';
  else if (assignees.some((a) => !a.duty)) errors.assignees = 'กรอกหน้าที่ของทุกคน';
  else if (new Set(assignees.map((a) => a.userId)).size < assignees.length) errors.assignees = 'เลือกคนเดียวกันซ้ำ';
  else if (assignees.length) {
    const found = (await query('select id, email, role from users where id = any($1) and erased_at is null', [assignees.map((a) => a.userId)])).rows;
    if (found.length < assignees.length || !found.every(assignable)) errors.assignees = 'มอบหมายได้เฉพาะทีม PR และนักศึกษา';
  }
  if (Object.keys(errors).length) throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', errors);
  return { ...row, assignees };
}

// Saves the list for an event; returns the ids just added
async function saveAssignees(c, eventId, assignees) {
  const before = (await c.query('select user_id from event_assignments where event_id = $1', [eventId])).rows.map((r) => r.user_id);
  await c.query('delete from event_assignments where event_id = $1 and not (user_id = any($2))', [eventId, assignees.map((a) => a.userId)]);
  for (const a of assignees) {
    await c.query(`insert into event_assignments (event_id, user_id, duty) values ($1, $2, $3)
      on conflict (event_id, user_id) do update set duty = $3`, [eventId, a.userId, a.duty]);
  }
  return assignees.map((a) => a.userId).filter((id) => !before.includes(id));
}
// d comes from checkEvent. Inside the caller's transaction (also used by requests.mjs).
export async function createEvent(c, d, user) {
  const row = (await c.query(`insert into events (title, type, location, start_at, end_at, visibility, description, internal_note, created_by)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`, [d.title, d.type, d.location, d.start, d.end, d.visibility, d.description, d.note, user.id])).rows[0];
  await eventAssigned(c, row, await saveAssignees(c, row.id, d.assignees));
  await audit(c, user, 'event.create', row.id, `สร้างกิจกรรม ${row.title}`, { assignees: d.assignees.length, visibility: row.visibility });
  return row;
}
const respond = async (res, req, e, status = 200) => {
  const right = rightOf(req.user, 'calendar');
  res.status(status).json({ event: eventOut(e, right, await assigneesOf([e.id]), req.user.id, await bannersOf([e.id])) });
};
// May this user see the event at all (the same rule as the list and GET /calendar/events/:id)
async function sees(user, e) {
  const right = rightOf(user, 'calendar');
  if (!right) return false;
  if (right !== 'own') return edits(right) || e.status === 'scheduled';
  return !!(await one('select 1 from event_assignments where event_id = $1 and user_id = $2', [e.id, user.id]));
}
// The event, locked, for a change of its banners by someone who may change it
async function changing(c, id, user) {
  const was = (await c.query('select * from events where id = $1 for update', [id])).rows[0];
  if (!was) throw new HttpError(404, 'ไม่พบกิจกรรมนี้');
  if (!manages(rightOf(user, 'calendar'), was, user.id)) throw new HttpError(403, 'แก้ไขได้เฉพาะกิจกรรมที่คุณสร้าง');
  if (was.status === 'cancelled') throw new HttpError(409, 'กิจกรรมนี้ยกเลิกแล้ว แก้ไขไม่ได้');
  return was;
}
// Parses the upload and checks the picture; field errors under `banner`
function receive(req, res, next) {
  upload(req, res, async (err) => {
    const f = req.file;
    const fail = async (status, text) => {
      if (f) await removeTemp([f]);
      next(new HttpError(status, text, { banner: text }));
    };
    try {
      if (err) return await fail(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? `ภาพใหญ่เกิน ${MAX_BANNER / MB} MB` : 'อัปโหลดไฟล์ไม่สำเร็จ');
      if (!f) return await fail(400, 'เลือกภาพแบนเนอร์');
      if (!BANNER_EXT.includes(extname(f.originalname).toLowerCase())) return await fail(400, 'รับเฉพาะภาพ JPG, PNG และ WebP');
      // The content must be what the name says (a renamed .exe is not a .png)
      if (!(await matchesName(f.path, f.originalname))) return await fail(400, `${f.originalname} ไม่ใช่ไฟล์ภาพจริง ตรวจไฟล์แล้วแนบใหม่`);
      next();
    } catch (e) {
      if (f) await removeTemp([f]);
      next(e);
    }
  });
}

router.get('/calendar/public', async (req, res) => {
  const { from, to } = range(req.query);
  const rows = (await query(`select id, title, start_at, end_at, location from events
    where visibility = 'public' and status = 'scheduled' and start_at < $2 and end_at >= $1 order by start_at limit 500`, [from, to])).rows;
  const banners = rows.length ? await bannersOf(rows.map((e) => e.id)) : [];
  res.json({ items: rows.map((e) => ({ title: e.title, startAt: e.start_at, endAt: e.end_at, location: e.location, banners: bannerList(banners, e.id) })) });
});

// Email addresses are for PR and admin: a secretary finds people by name
router.get('/calendar/people', writer, async (req, res) => {
  const full = edits(rightOf(req.user, 'calendar'));
  const q = str(req.query.q, 100, 'คำค้น');
  const rows = (await query(`select id, name, email, role from users
    where erased_at is null and (role in ('pr', 'admin') or email like '%@student.sru.ac.th')
      and ($1::text is null or name ilike $1 or ($2::boolean and email ilike $1))
    order by name, email limit 100`, [q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null, full])).rows;
  res.json({ items: rows.filter(assignable).map((u) => ({ id: u.id, name: u.name, role: u.role, ...(full ? { email: u.email } : {}) })) });
});

router.get('/calendar/events', requireModule('calendar'), async (req, res) => {
  const right = rightOf(req.user, 'calendar');
  const { from, to } = range(req.query);
  const rows = (await query(`select e.* from events e where e.start_at < $2 and e.end_at >= $1
      and ($3::boolean or e.status = 'scheduled')
      and ($4::uuid is null or exists (select 1 from event_assignments a where a.event_id = e.id and a.user_id = $4))
    order by e.start_at limit 500`, [from, to, edits(right), right === 'own' ? req.user.id : null])).rows;
  const ids = rows.map((e) => e.id);
  const [people, banners] = rows.length ? await Promise.all([assigneesOf(ids), bannersOf(ids)]) : [[], []];
  res.json({ items: rows.map((e) => eventOut(e, right, people, req.user.id, banners)) });
});

router.get('/calendar/events/:id', requireModule('calendar'), async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบกิจกรรมนี้');
  const e = await one('select * from events where id = $1', [req.params.id]);
  if (!e) throw new HttpError(404, 'ไม่พบกิจกรรมนี้');
  if (rightOf(req.user, 'calendar') === 'own' && !(await one('select 1 from event_assignments where event_id = $1 and user_id = $2', [e.id, req.user.id]))) {
    throw new HttpError(403, 'บัญชีนี้ไม่มีสิทธิ์ดูกิจกรรมนี้');
  }
  await respond(res, req, e);
});

router.post('/calendar/events', writer, async (req, res) => {
  const d = await checkEvent(req.body);
  if (!edits(rightOf(req.user, 'calendar'))) d.note = null;
  await respond(res, req, await tx((c) => createEvent(c, d, req.user)), 201);
});

router.put('/calendar/events/:id', writer, async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบกิจกรรมนี้');
  const right = rightOf(req.user, 'calendar');
  const d = await checkEvent(req.body);
  const e = await tx(async (c) => {
    const was = (await c.query('select * from events where id = $1 for update', [req.params.id])).rows[0];
    if (!was) throw new HttpError(404, 'ไม่พบกิจกรรมนี้');
    if (!manages(right, was, req.user.id)) throw new HttpError(403, 'แก้ไขได้เฉพาะกิจกรรมที่คุณสร้าง');
    if (was.status === 'cancelled') throw new HttpError(409, 'กิจกรรมนี้ยกเลิกแล้ว แก้ไขไม่ได้');
    if (!edits(right)) d.note = was.internal_note; // never seen by a secretary, so never cleared by one
    const row = (await c.query(`update events set title = $2, type = $3, location = $4, start_at = $5, end_at = $6, visibility = $7, description = $8,
      internal_note = $9, updated_at = now() where id = $1 returning *`, [was.id, d.title, d.type, d.location, d.start, d.end, d.visibility, d.description, d.note])).rows[0];
    const added = await saveAssignees(c, row.id, d.assignees);
    if (was.start_at.getTime() !== d.start.getTime()) await c.query('update event_assignments set reminded_at = null where event_id = $1', [row.id]);
    await eventAssigned(c, row, added);
    await audit(c, req.user, 'event.update', row.id, `แก้ไขกิจกรรม ${row.title}`, { assignees: d.assignees.length, added: added.length, visibility: row.visibility });
    return row;
  });
  await respond(res, req, e);
});

router.post('/calendar/events/:id/cancel', writer, async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบกิจกรรมนี้');
  const right = rightOf(req.user, 'calendar');
  const e = await tx(async (c) => {
    const was = (await c.query('select * from events where id = $1 for update', [req.params.id])).rows[0];
    if (!was) throw new HttpError(404, 'ไม่พบกิจกรรมนี้');
    if (!manages(right, was, req.user.id)) throw new HttpError(403, 'ยกเลิกได้เฉพาะกิจกรรมที่คุณสร้าง');
    if (was.status === 'cancelled') throw new HttpError(409, 'กิจกรรมนี้ยกเลิกแล้ว');
    const row = (await c.query(`update events set status = 'cancelled', updated_at = now() where id = $1 returning *`, [was.id])).rows[0];
    await eventCancelled(c, row);
    await audit(c, req.user, 'event.cancel', row.id, `ยกเลิกกิจกรรม ${row.title}`);
    return row;
  });
  await respond(res, req, e);
});

router.post('/calendar/events/:id/banners', writer, uploads, receive, async (req, res) => {
  const f = req.file;
  let stored = null;
  try {
    if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบกิจกรรมนี้');
    // Checked before the picture is decoded, so nobody makes the server work for an event they cannot change
    await tx((c) => changing(c, req.params.id, req.user));
    stored = await storeBanner(req.params.id, f);
    const e = await tx(async (c) => {
      const was = await changing(c, req.params.id, req.user);
      const { n } = (await c.query('select count(*)::int n from event_banners where event_id = $1', [was.id])).rows[0];
      if (n >= MAX_BANNERS) throw new HttpError(409, `แนบแบนเนอร์ได้ไม่เกิน ${MAX_BANNERS} ภาพ`, { banner: `แนบแบนเนอร์ได้ไม่เกิน ${MAX_BANNERS} ภาพ` });
      await c.query('insert into event_banners (id, event_id, file_path, created_by) values ($1, $2, $3, $4)', [stored.id, was.id, stored.path, req.user.id]);
      await audit(c, req.user, 'event.banner.add', was.id, `แนบแบนเนอร์กิจกรรม ${was.title}`, { banner: stored.id });
      return was;
    });
    stored = null;
    await respond(res, req, e, 201);
  } finally {
    if (stored) await removeStored(stored.path);
    await removeTemp([f]);
  }
});

router.delete('/calendar/events/:id/banners/:bannerId', writer, async (req, res) => {
  if (!UUID.test(req.params.id) || !UUID.test(req.params.bannerId)) throw new HttpError(404, 'ไม่พบแบนเนอร์นี้');
  let path = null;
  const e = await tx(async (c) => {
    const was = await changing(c, req.params.id, req.user);
    path = (await c.query('delete from event_banners where id = $1 and event_id = $2 returning file_path', [req.params.bannerId, was.id])).rows[0]?.file_path;
    if (!path) throw new HttpError(404, 'ไม่พบแบนเนอร์นี้');
    await audit(c, req.user, 'event.banner.remove', was.id, `ลบแบนเนอร์กิจกรรม ${was.title}`, { banner: req.params.bannerId });
    return was;
  });
  await removeStored(path);
  await respond(res, req, e);
});

// Revalidated on every view (ETag), so a picture stops showing as soon as its event is no longer public
router.get('/calendar/banners/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบแบนเนอร์นี้');
  const b = await one('select b.file_path, e.* from event_banners b join events e on e.id = b.event_id where b.id = $1', [req.params.id]);
  if (!b) throw new HttpError(404, 'ไม่พบแบนเนอร์นี้');
  const open = b.visibility === 'public' && b.status === 'scheduled';
  if (!open) {
    if (!req.user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
    if (!(await sees(req.user, b))) throw new HttpError(403, 'บัญชีนี้ไม่มีสิทธิ์ดูแบนเนอร์นี้');
  }
  sendMedia(res, b.file_path, open ? 'public, no-cache' : 'private, no-cache');
});
