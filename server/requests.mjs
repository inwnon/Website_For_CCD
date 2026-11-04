// คำขอใช้บริการ (SPEC.md Phase 2, rights in access.mjs): a secretary asks, PR decides, an approved request becomes a calendar event.
// - GET  /api/requests?status=            the requests the user may see, newest first
// - GET  /api/requests/:id
// - POST /api/requests                    { title, type, location, startAt, endAt, details }
// - POST /api/requests/:id/cancel         the requester, while it is pending
// - POST /api/requests/:id/approve        { assignees: [{ userId, duty }], note } makes the event (internal; PR adds to it on the calendar)
// - POST /api/requests/:id/reject         { note } the reason, shown to the requester
// A secretary sees and cancels only their own; an executive only reads.
// University staff ask to be let in like a secretary (request_access); PR or admin decides, only an admin revokes:
// - GET  /api/request-access                       the user's own row, and whether they may ask
// - POST /api/request-access                       { reason }
// - GET  /api/request-access/list?status=          PR, admin
// - POST /api/request-access/:id/approve|reject    PR, admin; reject needs { note }
// - POST /api/request-access/:id/revoke            admin
import { Router } from 'express';
import { mayAskRequests, requireModule, rightOf } from './access.mjs';
import { audit } from './audit.mjs';
import { requireUser } from './auth.mjs';
import { UUID, checkEvent, createEvent, time } from './calendar.mjs';
import { one, query, tx } from './db.mjs';
import { HttpError, str } from './http.mjs';
import { accessAsked, accessDecided, requestDecided, requestSubmitted } from './notify.mjs';

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

// ---- Who may ask (request_access) ----
const ACCESS = ['pending', 'approved', 'rejected'];
const accessOut = (a) => ({
  id: Number(a.id), email: a.email, name: a.name ?? null, reason: a.reason, status: a.status, reviewNote: a.review_note, reviewer: a.reviewer_name ?? null,
  reviewedAt: a.reviewed_at, askedAt: a.asked_at,
});
async function heldAccess(c, id) {
  const r = /^\d{1,15}$/.test(id) ? (await c.query('select * from request_access where id = $1 for update', [id])).rows[0] : null;
  if (!r) throw new HttpError(404, 'ไม่พบคำขอสิทธิ์นี้');
  return r;
}
async function decideAccess(req, status, note, action, summary) {
  return tx(async (c) => {
    const r = await heldAccess(c, req.params.id);
    if (r.status !== 'pending') throw new HttpError(409, 'คำขอสิทธิ์นี้ไม่ได้รอพิจารณาแล้ว');
    const row = (await c.query(`update request_access set status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() where id = $1 returning *`,
      [r.id, status, note, req.user.id])).rows[0];
    await accessDecided(c, row);
    await audit(c, req.user, action, r.email, summary(r.email));
    return row;
  });
}

router.get('/request-access', requireUser, async (req, res) => {
  const a = await one('select a.*, v.name reviewer_name from request_access a left join users v on v.id = a.reviewed_by where a.email = $1', [req.user.email]);
  res.json({ access: a ? accessOut(a) : null, canAsk: mayAskRequests(req.user) && a?.status !== 'pending' && a?.status !== 'approved' });
});

router.post('/request-access', requireUser, async (req, res) => {
  if (!mayAskRequests(req.user)) throw new HttpError(403, 'ขอสิทธิ์ได้เฉพาะบัญชีบุคลากรของมหาวิทยาลัย');
  const reason = str(req.body?.reason, 500, 'เหตุผล');
  const a = await tx(async (c) => {
    // A first ask, or a new one after a rejection; pending or approved stays as it is
    const row = (await c.query(`insert into request_access (email, reason) values ($1, $2)
      on conflict (email) do update set reason = excluded.reason, status = 'pending', review_note = null, reviewed_by = null, reviewed_at = null, asked_at = now()
        where request_access.status = 'rejected'
      returning *`, [req.user.email, reason])).rows[0];
    if (!row) throw new HttpError(409, 'ส่งคำขอสิทธิ์ไว้แล้ว');
    await accessAsked(c, row, req.user);
    await audit(c, req.user, 'access.ask', req.user.email, `${req.user.email} ขอสิทธิ์ใช้คำขอใช้บริการ`);
    return row;
  });
  res.status(201).json({ access: accessOut(a) });
});

router.get('/request-access/list', reviewer, async (req, res) => {
  const { status } = req.query;
  if (status !== undefined && !ACCESS.includes(/** @type {string} */ (status))) throw new HttpError(400, 'เลือกสถานะให้ถูกต้อง');
  const rows = (await query(`select a.*, u.name, v.name reviewer_name from request_access a left join users u on u.email = a.email
    left join users v on v.id = a.reviewed_by where ($1::text is null or a.status = $1) order by a.asked_at desc limit 200`, [status ?? null])).rows;
  res.json({ items: rows.map(accessOut) });
});

router.post('/request-access/:id/approve', reviewer, async (req, res) => {
  const note = str(req.body?.note, 1000, 'หมายเหตุ');
  res.json({ access: accessOut(await decideAccess(req, 'approved', note, 'access.approve', (e) => `ให้ ${e} ส่งคำขอใช้บริการได้`)) });
});

router.post('/request-access/:id/reject', reviewer, async (req, res) => {
  const note = str(req.body?.note, 1000, 'เหตุผล');
  if (!note) throw new HttpError(400, 'กรอกเหตุผลที่ไม่ให้สิทธิ์', { note: 'กรอกเหตุผลที่ไม่ให้สิทธิ์' });
  res.json({ access: accessOut(await decideAccess(req, 'rejected', note, 'access.reject', (e) => `ไม่ให้ ${e} ส่งคำขอใช้บริการ`)) });
});

router.post('/request-access/:id/revoke', requireModule('requests', 'all'), async (req, res) => {
  await tx(async (c) => {
    const r = await heldAccess(c, req.params.id);
    if (r.status !== 'approved') throw new HttpError(409, 'บัญชีนี้ไม่ได้มีสิทธิ์อยู่');
    await c.query('delete from request_access where id = $1', [r.id]);
    await audit(c, req.user, 'access.revoke', r.email, `ถอนสิทธิ์ส่งคำขอใช้บริการของ ${r.email}`);
  });
  res.status(204).end();
});
