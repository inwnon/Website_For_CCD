// แจ้งปัญหาการใช้งานระบบ: a form on contact.html, read by the PR team in pr.html (กล่องแจ้งปัญหา)
// - POST /api/feedback                    { message, page?, contact?, website? }  anyone, signed in or not; rate limited.
//                                         website is a field people never see: when filled (a bot) nothing is kept.
// - GET  /api/pr/feedback?status=new|done { items, unread }  PR team and admin
// - POST /api/pr/feedback/:id/status      { status: new|done }  PR team and admin; written to audit_log
import { Router } from 'express';
import { audit } from './audit.mjs';
import { requirePr } from './auth.mjs';
import { one, query, tx } from './db.mjs';
import { HttpError, str } from './http.mjs';
import { limit } from './security.mjs';

export const router = Router();
const STATUSES = ['new', 'done'];
const MIN_MESSAGE = 10;

router.post('/feedback', limit('feedback', { max: 10, windowMs: 3600e3, message: 'ส่งแจ้งปัญหาบ่อยเกินไป กรุณาลองใหม่ภายหลัง' }), async (req, res) => {
  const b = req.body || {};
  if (str(b.website, 200, 'ช่องนี้')) return res.status(201).json({ ok: true });
  const message = str(b.message, 2000, 'รายละเอียดปัญหา');
  if (!message || message.length < MIN_MESSAGE) throw new HttpError(400, `เล่าปัญหาที่พบอย่างน้อย ${MIN_MESSAGE} ตัวอักษร`);
  const page = str(b.page, 200, 'หน้าที่พบปัญหา');
  const contact = str(b.contact, 200, 'ช่องทางติดต่อกลับ');
  const ua = String(req.get('user-agent') || '').slice(0, 300) || null;
  await tx(async (c) => {
    const id = (await c.query('insert into feedback (message, page, contact, user_agent, sender_id) values ($1, $2, $3, $4, $5) returning id',
      [message, page, contact, ua, req.user?.id ?? null])).rows[0].id;
    // A notice for everyone in the PR team (shown on calendar.html; opens the box in pr.html)
    const text = `แจ้งปัญหาการใช้งานใหม่: ${message.slice(0, 80)}`;
    await c.query(`insert into notifications (user_id, kind, ref_id, text)
                   select u.id, 'feedback.new', $1, $2 from pr_team t join users u on u.email = t.email where t.role in ('pr', 'admin')`, [String(id), text]);
  });
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
  res.json({
    unread: n,
    items: rows.map((r) => ({ id: String(r.id), message: r.message, page: r.page, contact: r.contact, userAgent: r.user_agent,
      sender: r.sender, status: r.status, createdAt: r.created_at, doneAt: r.done_at, doneBy: r.done_by })),
  });
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
