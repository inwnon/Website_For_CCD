// แจ้งปัญหาการใช้งานระบบ: a form on contact.html, read by the PR team in pr.html (กล่องแจ้งปัญหา)
// - POST /api/feedback                    { message, page?, contact?, website? }  anyone, signed in or not; rate limited.
//                                         JSON, or multipart: field "data" (that JSON) + up to 3 pictures in "files".
//                                         website is a field people never see: when filled (a bot) nothing is kept.
// - GET  /api/pr/feedback?status=new|done { items, unread }  PR team and admin; each item lists its pictures
// - GET  /api/pr/feedback/:id/files/:fileId  one picture (WebP), PR team and admin
// - POST /api/pr/feedback/:id/status      { status: new|done }  PR team and admin; written to audit_log
import { extname, join } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { audit } from './audit.mjs';
import { requirePr } from './auth.mjs';
import { UUID } from './calendar.mjs';
import { one, query, tx } from './db.mjs';
import { UPLOAD_DIR, removeFeedbackDir, removeTemp, sendMedia, storeScreenshot } from './files.mjs';
import { HttpError, str } from './http.mjs';
import { limit, matchesName } from './security.mjs';

export const router = Router();
const STATUSES = ['new', 'done'];
const MIN_MESSAGE = 10;

// Pictures: a screen capture or a photo of the screen. Anyone may send them, so only pictures, few and small.
const MB = 1024 * 1024;
const MAX_FILES = 3, MAX_FILE = 5 * MB;
const IMAGES = ['.jpg', '.jpeg', '.png', '.webp'];
const upload = multer({ dest: join(UPLOAD_DIR, 'tmp'), limits: { fileSize: MAX_FILE, files: MAX_FILES, fields: 1, fieldSize: 16 * 1024 }, defParamCharset: 'utf8' })
  .array('files', MAX_FILES);

// Parses JSON or multipart into req.data and checks each picture; field errors under `files`. Temp files go on any error.
function receive(req, res, next) {
  upload(req, res, async (err) => {
    const files = /** @type {any[]} */ (req.files || []);
    const fail = async (status, text) => { await removeTemp(files); next(new HttpError(status, text, { files: text })); };
    try {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return await fail(413, `รูปใหญ่เกิน ${MAX_FILE / MB} MB`);
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return await fail(400, `แนบรูปได้ไม่เกิน ${MAX_FILES} รูป`);
        return await fail(400, 'อัปโหลดรูปไม่สำเร็จ');
      }
      for (const f of files) {
        if (!IMAGES.includes(extname(f.originalname).toLowerCase())) return await fail(400, `ไม่รับไฟล์ ${f.originalname}: รับเฉพาะรูป JPG, PNG และ WebP`);
        // The content must be what the name says (a renamed .exe is not a .png)
        if (!(await matchesName(f.path, f.originalname))) return await fail(400, `${f.originalname} ไม่ใช่ไฟล์รูปจริง ตรวจไฟล์แล้วแนบใหม่`);
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

router.post('/feedback', limit('feedback', { max: 10, windowMs: 3600e3, message: 'ส่งแจ้งปัญหาบ่อยเกินไป กรุณาลองใหม่ภายหลัง' }), receive, async (req, res) => {
  const files = /** @type {any[]} */ (req.files || []);
  let id = null;
  try {
    const b = req.data || {};
    if (str(b.website, 200, 'ช่องนี้')) return res.status(201).json({ ok: true });
    const message = str(b.message, 2000, 'รายละเอียดปัญหา');
    if (!message || message.length < MIN_MESSAGE) throw new HttpError(400, `เล่าปัญหาที่พบอย่างน้อย ${MIN_MESSAGE} ตัวอักษร`);
    const page = str(b.page, 200, 'หน้าที่พบปัญหา');
    const contact = str(b.contact, 200, 'ช่องทางติดต่อกลับ');
    const ua = String(req.get('user-agent') || '').slice(0, 300) || null;
    await tx(async (c) => {
      id = (await c.query('insert into feedback (message, page, contact, user_agent, sender_id) values ($1, $2, $3, $4, $5) returning id',
        [message, page, contact, ua, req.user?.id ?? null])).rows[0].id;
      for (const [i, f] of files.entries()) {
        const s = await storeScreenshot(id, f);
        // Control characters would stop Postgres; the name is only shown to the PR team
        const name = f.originalname.replace(/\p{Cc}/gu, '').slice(0, 255) || 'รูป';
        await c.query('insert into feedback_files (feedback_id, file_path, file_name, size, position) values ($1, $2, $3, $4, $5)', [id, s.path, name, s.size, i]);
      }
      // A notice for everyone in the PR team (shown on calendar.html; opens the box in pr.html)
      const text = `แจ้งปัญหาการใช้งานใหม่: ${message.slice(0, 80)}`;
      await c.query(`insert into notifications (user_id, kind, ref_id, text)
                     select u.id, 'feedback.new', $1, $2 from pr_team t join users u on u.email = t.email where t.role in ('pr', 'admin')`, [String(id), text]);
    });
  } catch (err) {
    if (id) await removeFeedbackDir(id);
    throw err;
  } finally {
    await removeTemp(files);
  }
  res.status(201).json({ ok: true });
});

router.get('/pr/feedback', requirePr, async (req, res) => {
  const status = STATUSES.includes(String(req.query.status)) ? String(req.query.status) : 'new';
  const rows = (await query(
    `select f.id, f.message, f.page, f.contact, f.user_agent, f.status, f.created_at, f.done_at,
            coalesce(nullif(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.name, u.email) sender,
            coalesce(nullif(trim(concat_ws(' ', d.first_name, d.last_name)), ''), d.name, d.email) done_by
       from feedback f left join users u on u.id = f.sender_id left join users d on d.id = f.done_by
      where f.status = $1 order by f.created_at desc limit 200`, [status])).rows;
  const { n } = await one("select count(*)::int n from feedback where status = 'new'");
  const pics = (await query('select id, feedback_id, file_name from feedback_files where feedback_id = any($1) order by position',
    [rows.map((r) => r.id)])).rows;
  res.json({
    unread: n,
    items: rows.map((r) => ({ id: String(r.id), message: r.message, page: r.page, contact: r.contact, userAgent: r.user_agent,
      sender: r.sender, status: r.status, createdAt: r.created_at, doneAt: r.done_at, doneBy: r.done_by,
      files: pics.filter((p) => p.feedback_id === r.id).map((p) => ({ id: p.id, name: p.file_name })) })),
  });
});

router.get('/pr/feedback/:id/files/:fileId', requirePr, async (req, res) => {
  if (!/^\d{1,18}$/.test(req.params.id) || !UUID.test(req.params.fileId)) throw new HttpError(404, 'ไม่พบรูปนี้');
  const f = await one('select file_path from feedback_files where id = $1 and feedback_id = $2', [req.params.fileId, req.params.id]);
  if (!f) throw new HttpError(404, 'ไม่พบรูปนี้');
  sendMedia(res, f.file_path, 'private, no-store');
});

router.post('/pr/feedback/:id/status', requirePr, async (req, res) => {
  const id = req.params.id;
  if (!/^\d{1,18}$/.test(id)) throw new HttpError(404, 'ไม่พบเรื่องที่แจ้ง');
  const status = req.body?.status;
  if (!STATUSES.includes(status)) throw new HttpError(400, 'สถานะไม่ถูกต้อง');
  await tx(async (c) => {
    const r = (await c.query(`update feedback set status = $2, done_by = case when $2 = 'done' then $3::uuid end, done_at = case when $2 = 'done' then now() end
                               where id = $1 returning id`, [id, status, req.user.id])).rows[0];
    if (!r) throw new HttpError(404, 'ไม่พบเรื่องที่แจ้ง');
    await audit(c, req.user, 'feedback.status', `feedback:${id}`, status === 'done' ? 'แก้ปัญหาที่แจ้งแล้ว' : 'ย้ายกลับเป็นเรื่องใหม่', { status });
  });
  res.json({ ok: true });
});
