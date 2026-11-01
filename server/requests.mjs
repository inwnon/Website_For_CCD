// คำขอใช้บริการ (SPEC.md Phase 2, rights in access.mjs): a secretary asks, PR decides, an approved request becomes a calendar event.
// - GET  /api/requests?status=            the requests the user may see, newest first
// - GET  /api/requests/:id
// - POST /api/requests                    { title, type, location, startAt, endAt, details }
// - POST /api/requests/:id/cancel         the requester, while it is pending
// - POST /api/requests/:id/approve        { assignees: [{ userId, duty }], note } makes the event (internal; PR adds to it on the calendar)
// - POST /api/requests/:id/reject         { note } the reason, shown to the requester
// A secretary sees and cancels only their own; an executive only reads.
import { Router } from 'express';
import { requireModule, rightOf } from './access.mjs';
import { audit } from './audit.mjs';
import { UUID, checkEvent, createEvent, time } from './calendar.mjs';
import { one, query, tx } from './db.mjs';
import { HttpError, str } from './http.mjs';
import { requestDecided, requestSubmitted } from './notify.mjs';

const TYPES = ['photo', 'video', 'news', 'other'];
const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
const SELECT = `select r.*, u.name requester_name, v.name reviewer_name from service_requests r
  left join users u on u.id = r.requester_id left join users v on v.id = r.reviewed_by`;

const reviewer = requireModule('requests', 'all', 'approve');

export const router = Router();

const requestOut = (r) => ({
  id: r.id, title: r.title, type: r.type, startAt: r.start_at, endAt: r.end_at, location: r.location, details: r.details, status: r.status,
  requester: r.requester_name, reviewer: r.reviewer_name, reviewNote: r.review_note, reviewedAt: r.reviewed_at, eventId: r.event_id, createdAt: r.created_at,
});
const respond = async (res, id, status = 200) => res.status(status).json({ request: requestOut(await one(`${SELECT} where r.id = $1`, [id])) });

// Throws 400 with a field → message map
function checkRequest(b) {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'ไม่พบข้อมูลคำขอ');
  const errors = {};
  const row = {
    title: str(b.title, 200, 'ชื่องาน'), type: b.type, location: str(b.location, 200, 'สถานที่'), start: time(b.startAt), end: time(b.endAt),
    details: str(b.details, 2000, 'รายละเอียด'),
  };
  if (!row.title) errors.title = 'กรอกชื่องาน';
  if (!TYPES.includes(row.type)) errors.type = 'เลือกประเภทคำขอ';
  if (!row.location) errors.location = 'กรอกสถานที่';
  if (!row.start) errors.startAt = 'เลือกวันเวลาเริ่ม';
  else if (row.start <= new Date()) errors.startAt = 'เวลาเริ่มต้องยังไม่ผ่านไป';
  if (!row.end) errors.endAt = 'เลือกวันเวลาสิ้นสุด';
  if (row.start && row.end && row.end <= row.start) errors.endAt = 'เวลาสิ้นสุดต้องหลังเวลาเริ่ม';
  if (Object.keys(errors).length) throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', errors);
  return row;
}

// The request, held until the transaction ends, so two people cannot decide it at once
async function held(c, id) {
  if (!UUID.test(id)) throw new HttpError(404, 'ไม่พบคำขอนี้');
  const r = (await c.query('select * from service_requests where id = $1 for update', [id])).rows[0];
  if (!r) throw new HttpError(404, 'ไม่พบคำขอนี้');
  return r;
}
const decidable = (r) => { if (r.status !== 'pending') throw new HttpError(409, 'คำขอนี้ไม่ได้รอพิจารณาแล้ว'); };

router.get('/requests', requireModule('requests'), async (req, res) => {
  const { status } = req.query;
  if (status !== undefined && !STATUSES.includes(/** @type {string} */ (status))) throw new HttpError(400, 'เลือกสถานะให้ถูกต้อง');
  const own = rightOf(req.user, 'requests') === 'own';
  const rows = (await query(`${SELECT} where ($1::uuid is null or r.requester_id = $1) and ($2::text is null or r.status = $2)
    order by r.created_at desc limit 200`, [own ? req.user.id : null, status ?? null])).rows;
  res.json({ items: rows.map(requestOut) });
});

router.get('/requests/:id', requireModule('requests'), async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบคำขอนี้');
  const r = await one(`${SELECT} where r.id = $1`, [req.params.id]);
  if (!r) throw new HttpError(404, 'ไม่พบคำขอนี้');
  if (rightOf(req.user, 'requests') === 'own' && r.requester_id !== req.user.id) throw new HttpError(403, 'บัญชีนี้ไม่มีสิทธิ์ดูคำขอนี้');
  res.json({ request: requestOut(r) });
});

router.post('/requests', requireModule('requests', 'all', 'own'), async (req, res) => {
  const d = checkRequest(req.body);
  const id = await tx(async (c) => {
    const r = (await c.query(`insert into service_requests (requester_id, title, type, start_at, end_at, location, details)
      values ($1, $2, $3, $4, $5, $6, $7) returning *`, [req.user.id, d.title, d.type, d.start, d.end, d.location, d.details])).rows[0];
    await requestSubmitted(c, r, req.user);
    await audit(c, req.user, 'request.create', r.id, `ส่งคำขอ ${r.title}`, { type: r.type });
    return r.id;
  });
  await respond(res, id, 201);
});

router.post('/requests/:id/cancel', requireModule('requests', 'all', 'own'), async (req, res) => {
  await tx(async (c) => {
    const r = await held(c, req.params.id);
    if (rightOf(req.user, 'requests') === 'own' && r.requester_id !== req.user.id) throw new HttpError(403, 'ยกเลิกได้เฉพาะคำขอของคุณ');
    decidable(r);
    await c.query(`update service_requests set status = 'cancelled' where id = $1`, [r.id]);
    await audit(c, req.user, 'request.cancel', r.id, `ยกเลิกคำขอ ${r.title}`);
  });
  await respond(res, req.params.id);
});

router.post('/requests/:id/approve', reviewer, async (req, res) => {
  const note = str(req.body?.note, 1000, 'หมายเหตุ');
  await tx(async (c) => {
    const r = await held(c, req.params.id);
    decidable(r);
    const d = await checkEvent({ title: r.title, type: 'media', location: r.location, startAt: r.start_at.toISOString(), endAt: r.end_at.toISOString(),
      description: r.details, assignees: req.body?.assignees ?? [] });
    const e = await createEvent(c, d, req.user);
    const row = (await c.query(`update service_requests set status = 'approved', review_note = $2, reviewed_by = $3, reviewed_at = now(), event_id = $4
      where id = $1 returning *`, [r.id, note, req.user.id, e.id])).rows[0];
    await requestDecided(c, row);
    await audit(c, req.user, 'request.approve', r.id, `อนุมัติคำขอ ${r.title}`, { event: e.id, assignees: d.assignees.length });
  });
  await respond(res, req.params.id);
});

router.post('/requests/:id/reject', reviewer, async (req, res) => {
  const note = str(req.body?.note, 1000, 'เหตุผล');
  if (!note) throw new HttpError(400, 'กรอกเหตุผลที่ไม่อนุมัติ', { note: 'กรอกเหตุผลที่ไม่อนุมัติ' });
  await tx(async (c) => {
    const r = await held(c, req.params.id);
    decidable(r);
    const row = (await c.query(`update service_requests set status = 'rejected', review_note = $2, reviewed_by = $3, reviewed_at = now()
      where id = $1 returning *`, [r.id, note, req.user.id])).rows[0];
    await requestDecided(c, row);
    await audit(c, req.user, 'request.reject', r.id, `ไม่อนุมัติคำขอ ${r.title}`);
  });
  await respond(res, req.params.id);
});
