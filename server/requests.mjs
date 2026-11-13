// คำขอใช้บริการ (SPEC.md Phase 2, rights in access.mjs): a secretary asks, PR decides, an approved request becomes a calendar event.
// - GET  /api/requests?status=            the requests the user may see, newest first
// - GET  /api/requests/:id                with its files and messages
// - GET  /api/requests/:id/files/:fileId  a download, for whoever may see the request
// - POST /api/requests                    { title, type, location, startAt, endAt, details } as JSON, or multipart: data (that JSON) + files (≤ 5)
// - POST /api/requests/:id/ask            { note } PR wants more: status info (รอข้อมูลเพิ่ม)
// - POST /api/requests/:id/reply          the requester, while info: data { body } + files; back to pending
// - POST /api/requests/:id/cancel         the requester, while it is pending or info
// - POST /api/requests/:id/approve        { assignees: [{ userId, duty }], note } makes the event (internal; PR adds to it on the calendar)
// - POST /api/requests/:id/reject         { note } the reason, shown to the requester
// A secretary sees and cancels only their own; an executive only reads.
// University staff ask to be let in like a secretary (request_access); PR or admin decides, only an admin revokes:
// - GET  /api/request-access                       the user's own row, and whether they may ask
// - POST /api/request-access                       { reason }
// - GET  /api/request-access/list?status=          PR, admin
// - POST /api/request-access/:id/approve|reject    PR, admin; reject needs { note }
// - POST /api/request-access/:id/revoke            admin
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { mayAskRequests, requireModule, rightOf } from './access.mjs';
import { audit } from './audit.mjs';
import { requireUser } from './auth.mjs';
import { UUID, checkEvent, createEvent, time } from './calendar.mjs';
import { one, query, tx } from './db.mjs';
import { UPLOAD_DIR, mimeOf, removeStored, removeTemp, sendMedia, storeDocument } from './files.mjs';
import { HttpError, str } from './http.mjs';
import { accessAsked, accessDecided, requestDecided, requestInfoAsked, requestReplied, requestSubmitted } from './notify.mjs';
import { limit, matchesName } from './security.mjs';

const TYPES = ['photo', 'video', 'news', 'other'];
const STATUSES = ['pending', 'info', 'approved', 'rejected', 'cancelled'];
const OPEN = ['pending', 'info']; // still to be decided

// Files sent with a request or an answer (SPEC §7: the document file types and sizes)
const MB = 1024 * 1024;
const MAX_FILES = 5, MAX_FILE = 20 * MB, MAX_IMAGE = 10 * MB;
const IMAGES = ['.jpg', '.jpeg', '.png'];
const ALLOWED = ['.pdf', '.docx', '.xlsx', '.pptx', ...IMAGES];
const upload = multer({ dest: join(UPLOAD_DIR, 'tmp'), limits: { fileSize: MAX_FILE, files: MAX_FILES, fields: 1, fieldSize: 16 * 1024 }, defParamCharset: 'utf8' })
  .array('files', MAX_FILES);
const uploads = limit('request-files', { max: 60, windowMs: 10 * 60 * 1000 });
const SELECT = `select r.*, u.name requester_name, v.name reviewer_name from service_requests r
  left join users u on u.id = r.requester_id left join users v on v.id = r.reviewed_by`;

const reviewer = requireModule('requests', 'all', 'approve');

export const router = Router();

const requestOut = (r) => ({
  id: r.id, title: r.title, type: r.type, startAt: r.start_at, endAt: r.end_at, location: r.location, details: r.details, status: r.status,
  requester: r.requester_name, requesterId: r.requester_id, reviewer: r.reviewer_name, reviewNote: r.review_note, reviewedAt: r.reviewed_at, eventId: r.event_id, createdAt: r.created_at,
});
// One request with its files (messageId null: sent with the request) and what PR asked and the requester answered
async function respond(res, id, status = 200) {
  const [r, files, messages] = await Promise.all([
    one(`${SELECT} where r.id = $1`, [id]),
    query('select id, message_id, file_name, mime, size, created_at from service_request_files where request_id = $1 order by created_at, file_name', [id]),
    query(`select m.id, m.kind, m.body, m.created_at, u.name author from service_request_messages m left join users u on u.id = m.author_id
      where m.request_id = $1 order by m.created_at, m.id`, [id]),
  ]);
  res.status(status).json({ request: {
    ...requestOut(r),
    files: files.rows.map((f) => ({ id: f.id, messageId: f.message_id && String(f.message_id), name: f.file_name, mime: f.mime, size: Number(f.size), createdAt: f.created_at })),
    messages: messages.rows.map((m) => ({ id: String(m.id), kind: m.kind, body: m.body, author: m.author, createdAt: m.created_at })),
  } });
}

// Parses an upload (multipart: field "data" JSON + files in "files") or a plain JSON body into req.data; checks each file.
// Field errors under `files`.
function receive(req, res, next) {
  upload(req, res, async (err) => {
    const files = /** @type {any[]} */ (req.files || []);
    const fail = async (status, text) => { await removeTemp(files); next(new HttpError(status, text, { files: text })); };
    try {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return await fail(413, `ไฟล์ใหญ่เกิน ${MAX_FILE / MB} MB`);
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return await fail(400, `แนบได้ไม่เกิน ${MAX_FILES} ไฟล์`);
        return await fail(400, 'อัปโหลดไฟล์ไม่สำเร็จ');
      }
      for (const f of files) {
        const ext = extname(f.originalname).toLowerCase();
        if (!ALLOWED.includes(ext)) return await fail(400, `ไม่รับไฟล์ ${f.originalname}: รับเฉพาะ PDF, DOCX, XLSX, PPTX, JPG และ PNG`);
        if (IMAGES.includes(ext) && f.size > MAX_IMAGE) return await fail(413, `${f.originalname} ใหญ่เกิน ${MAX_IMAGE / MB} MB`);
        // The content must be what the name says (a renamed .exe is not a .pdf)
        if (!(await matchesName(f.path, f.originalname))) return await fail(400, `${f.originalname} ไม่ใช่ไฟล์ ${ext.slice(1).toUpperCase()} จริง ตรวจไฟล์แล้วแนบใหม่`);
      }
      req.data = req.is('multipart/form-data') ? JSON.parse(req.body?.data || '{}') : req.body;
      next();
    } catch (e) {
      if (e instanceof SyntaxError) return fail(400, 'ข้อมูลที่ส่งมาไม่ถูกต้อง');
      await removeTemp(files);
      next(e);
    }
  });
}

// Stores the files, then runs fn(client, store) in a transaction, where store(messageId) adds their rows;
// if anything fails the stored files go too. The temp uploads are always removed.
async function withFiles(id, req, fn) {
  const files = /** @type {any[]} */ (req.files || []);
  const stored = [];
  try {
    for (const f of files) {
      // Control characters would stop Postgres; the name is only used for the download
      stored.push({ path: await storeDocument(id, f, 'requests'), name: f.originalname.replace(/\p{Cc}/gu, '').slice(0, 255) || 'file', mime: mimeOf(f.originalname), size: f.size });
    }
    return await tx((c) => fn(c, async (messageId = null) => {
      for (const s of stored) {
        await c.query(`insert into service_request_files (request_id, message_id, file_path, file_name, mime, size, uploaded_by)
          values ($1, $2, $3, $4, $5, $6, $7)`, [id, messageId, s.path, s.name, s.mime, s.size, req.user.id]);
      }
      return stored.length;
    }));
  } catch (err) {
    await Promise.all(stored.map((s) => removeStored(s.path)));
    throw err;
  } finally {
    await removeTemp(files);
  }
}

// The request, if this user may see it (a secretary or staff requester: only their own)
async function visible(req) {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบคำขอนี้');
  const r = await one('select * from service_requests where id = $1', [req.params.id]);
  if (!r) throw new HttpError(404, 'ไม่พบคำขอนี้');
  if (rightOf(req.user, 'requests') === 'own' && r.requester_id !== req.user.id) throw new HttpError(403, 'บัญชีนี้ไม่มีสิทธิ์ดูคำขอนี้');
  return r;
}

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
const decidable = (r) => { if (!OPEN.includes(r.status)) throw new HttpError(409, 'คำขอนี้ไม่ได้รอพิจารณาแล้ว'); };

router.get('/requests', requireModule('requests'), async (req, res) => {
  const { status } = req.query;
  if (status !== undefined && !STATUSES.includes(/** @type {string} */ (status))) throw new HttpError(400, 'เลือกสถานะให้ถูกต้อง');
  const own = rightOf(req.user, 'requests') === 'own';
  const rows = (await query(`${SELECT} where ($1::uuid is null or r.requester_id = $1) and ($2::text is null or r.status = $2)
    order by r.created_at desc limit 200`, [own ? req.user.id : null, status ?? null])).rows;
  res.json({ items: rows.map(requestOut) });
});

router.get('/requests/:id', requireModule('requests'), async (req, res) => {
  const r = await visible(req);
  await respond(res, r.id);
});

// A file sent with the request or an answer: always a download, for whoever may see the request
router.get('/requests/:id/files/:fileId', requireModule('requests'), async (req, res) => {
  const r = await visible(req);
  const f = UUID.test(req.params.fileId) ? await one('select file_path, file_name from service_request_files where id = $1 and request_id = $2', [req.params.fileId, r.id]) : null;
  if (!f) throw new HttpError(404, 'ไม่พบไฟล์นี้');
  sendMedia(res, f.file_path, 'private, no-store', f.file_name);
});

router.post('/requests', requireModule('requests', 'all', 'own'), uploads, receive, async (req, res) => {
  const id = randomUUID();
  let d;
  try {
    d = checkRequest(req.data);
  } catch (err) {
    await removeTemp(req.files || []);
    throw err;
  }
  await withFiles(id, req, async (c, store) => {
    const r = (await c.query(`insert into service_requests (id, requester_id, title, type, start_at, end_at, location, details)
      values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`, [id, req.user.id, d.title, d.type, d.start, d.end, d.location, d.details])).rows[0];
    const files = await store();
    await requestSubmitted(c, r, req.user);
    await audit(c, req.user, 'request.create', r.id, `ส่งคำขอ ${r.title}`, { type: r.type, files });
  });
  await respond(res, id, 201);
});

// PR asks the requester for more: the request waits (info) until they answer
router.post('/requests/:id/ask', reviewer, async (req, res) => {
  const note = str(req.body?.note, 2000, 'ข้อความ');
  if (!note) throw new HttpError(400, 'กรอกสิ่งที่ต้องการเพิ่มเติม', { note: 'กรอกสิ่งที่ต้องการเพิ่มเติม' });
  await tx(async (c) => {
    const r = await held(c, req.params.id);
    if (r.status !== 'pending') throw new HttpError(409, r.status === 'info' ? 'ขอข้อมูลไปแล้ว รอผู้ขอตอบกลับ' : 'คำขอนี้ไม่ได้รอพิจารณาแล้ว');
    await c.query(`insert into service_request_messages (request_id, author_id, kind, body) values ($1, $2, 'ask', $3)`, [r.id, req.user.id, note]);
    await c.query(`update service_requests set status = 'info' where id = $1`, [r.id]);
    await requestInfoAsked(c, r, note);
    await audit(c, req.user, 'request.ask', r.id, `ขอข้อมูลเพิ่มเติม ${r.title}`);
  });
  await respond(res, req.params.id);
});

// The requester answers (text, files or both): the request waits for PR again
router.post('/requests/:id/reply', requireModule('requests'), uploads, receive, async (req, res) => {
  const body = str(req.data?.body, 2000, 'ข้อความ') || '';
  const count = /** @type {any[]} */ (req.files || []).length;
  try {
    const r = await visible(req);
    if (r.requester_id !== req.user.id) throw new HttpError(403, 'ตอบกลับได้เฉพาะผู้ขอ');
    if (!body && !count) throw new HttpError(400, 'พิมพ์ข้อความหรือแนบไฟล์', { body: 'พิมพ์ข้อความหรือแนบไฟล์' });
  } catch (err) {
    await removeTemp(req.files || []);
    throw err;
  }
  await withFiles(req.params.id, req, async (c, store) => {
    const r = await held(c, req.params.id);
    if (r.status !== 'info') throw new HttpError(409, 'คำขอนี้ไม่ได้รอข้อมูลเพิ่มเติม');
    const m = (await c.query(`insert into service_request_messages (request_id, author_id, kind, body) values ($1, $2, 'reply', $3) returning id`, [r.id, req.user.id, body])).rows[0];
    const files = await store(m.id);
    await c.query(`update service_requests set status = 'pending' where id = $1`, [r.id]);
    await requestReplied(c, r, req.user, body || `แนบไฟล์ ${files} ไฟล์`);
    await audit(c, req.user, 'request.reply', r.id, `ส่งข้อมูลเพิ่มเติม ${r.title}`, { files });
  });
  await respond(res, req.params.id);
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
