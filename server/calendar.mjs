// ปฏิทินงาน (SPEC.md Phase 1, rights in access.mjs): events on calendar.html, the people assigned to them, and the public feed.
// - GET  /api/calendar/public?from=&to=        public events: title, startAt, endAt, location and nothing else (index.html)
// - GET  /api/calendar/events?from=&to=        the events the user may see; dates are YYYY-MM-DD, Bangkok days, both included
// - GET  /api/calendar/events/:id
// - POST /api/calendar/events                  { title, type, location, startAt, endAt, visibility, description, internalNote, assignees: [{ userId, duty }] }
// - PUT  /api/calendar/events/:id              the same fields
// - POST /api/calendar/events/:id/cancel       the row stays, marked cancelled
// - GET  /api/calendar/people?q=               who can be assigned
// A student sees only the events they are on. internal_note is for PR and admin; cancelled events too, in the list.
import { Router } from 'express';
import { requireModule, rightOf } from './access.mjs';
import { audit } from './audit.mjs';
import { one, query, tx } from './db.mjs';
import { HttpError, str } from './http.mjs';
import { eventAssigned, eventCancelled } from './notify.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const TYPES = ['meeting', 'activity', 'media', 'other'];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 400;
const MAX_ASSIGNEES = 30;

const edits = (right) => right === 'all' || right === 'edit';
const assignable = (u) => ['all', 'edit', 'own'].includes(rightOf(u, 'calendar'));
const editor = requireModule('calendar', 'all', 'edit');

export const router = Router();

// A real calendar day (Date would turn 31 February into March) in Christian years, so a Buddhist-era year is refused
function realDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return y >= 2020 && y <= 2100 && new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d;
}
const time = (v) => (typeof v === 'string' && TIME.test(v) && realDay(v.slice(0, 10)) && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);

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
function eventOut(e, right, people) {
  return {
    id: e.id, title: e.title, type: e.type, location: e.location, startAt: e.start_at, endAt: e.end_at, status: e.status,
    visibility: e.visibility, description: e.description,
    assignees: people.filter((p) => p.event_id === e.id).map((p) => ({ ...(edits(right) ? { id: p.user_id } : {}), name: p.name, duty: p.duty })),
    ...(edits(right) ? { internalNote: e.internal_note, createdAt: e.created_at, updatedAt: e.updated_at } : {}),
  };
}

// Throws 400 with a field → message map; assignees must exist and be people who work on events
async function checkEvent(b) {
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
const respond = async (res, req, e, status = 200) => {
  const right = rightOf(req.user, 'calendar');
  res.status(status).json({ event: eventOut(e, right, await assigneesOf([e.id])) });
};

router.get('/calendar/public', async (req, res) => {
  const { from, to } = range(req.query);
  const rows = (await query(`select title, start_at, end_at, location from events
    where visibility = 'public' and status = 'scheduled' and start_at < $2 and end_at >= $1 order by start_at limit 500`, [from, to])).rows;
  res.json({ items: rows.map((e) => ({ title: e.title, startAt: e.start_at, endAt: e.end_at, location: e.location })) });
});

router.get('/calendar/people', editor, async (req, res) => {
  const q = str(req.query.q, 100, 'คำค้น');
  const rows = (await query(`select id, name, email, role from users
    where erased_at is null and (role in ('pr', 'admin') or email like '%@student.sru.ac.th')
      and ($1::text is null or name ilike $1 or email ilike $1)
    order by name, email limit 100`, [q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null])).rows;
  res.json({ items: rows.filter(assignable).map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })) });
});

router.get('/calendar/events', requireModule('calendar'), async (req, res) => {
  const right = rightOf(req.user, 'calendar');
  const { from, to } = range(req.query);
  const rows = (await query(`select e.* from events e where e.start_at < $2 and e.end_at >= $1
      and ($3::boolean or e.status = 'scheduled')
      and ($4::uuid is null or exists (select 1 from event_assignments a where a.event_id = e.id and a.user_id = $4))
    order by e.start_at limit 500`, [from, to, edits(right), right === 'own' ? req.user.id : null])).rows;
  const people = rows.length ? await assigneesOf(rows.map((e) => e.id)) : [];
  res.json({ items: rows.map((e) => eventOut(e, right, people)) });
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

router.post('/calendar/events', editor, async (req, res) => {
  const d = await checkEvent(req.body);
  const e = await tx(async (c) => {
    const row = (await c.query(`insert into events (title, type, location, start_at, end_at, visibility, description, internal_note, created_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`, [d.title, d.type, d.location, d.start, d.end, d.visibility, d.description, d.note, req.user.id])).rows[0];
    await eventAssigned(c, row, await saveAssignees(c, row.id, d.assignees));
    await audit(c, req.user, 'event.create', row.id, `สร้างกิจกรรม ${row.title}`, { assignees: d.assignees.length, visibility: row.visibility });
    return row;
  });
  await respond(res, req, e, 201);
});

router.put('/calendar/events/:id', editor, async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบกิจกรรมนี้');
  const d = await checkEvent(req.body);
  const e = await tx(async (c) => {
    const was = (await c.query('select * from events where id = $1 for update', [req.params.id])).rows[0];
    if (!was) throw new HttpError(404, 'ไม่พบกิจกรรมนี้');
    if (was.status === 'cancelled') throw new HttpError(409, 'กิจกรรมนี้ยกเลิกแล้ว แก้ไขไม่ได้');
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

router.post('/calendar/events/:id/cancel', editor, async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบกิจกรรมนี้');
  const e = await tx(async (c) => {
    const was = (await c.query('select * from events where id = $1 for update', [req.params.id])).rows[0];
    if (!was) throw new HttpError(404, 'ไม่พบกิจกรรมนี้');
    if (was.status === 'cancelled') throw new HttpError(409, 'กิจกรรมนี้ยกเลิกแล้ว');
    const row = (await c.query(`update events set status = 'cancelled', updated_at = now() where id = $1 returning *`, [was.id])).rows[0];
    await eventCancelled(c, row);
    await audit(c, req.user, 'event.cancel', row.id, `ยกเลิกกิจกรรม ${row.title}`);
    return row;
  });
  await respond(res, req, e);
});
