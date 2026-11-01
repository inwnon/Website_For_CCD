// PDPA (phase 10): the data subject's rights and how long things are kept
// - GET    /api/me/data                    everything the system holds about me, as a JSON file
// - GET    /api/me/delete-request          my open request (or null) · POST { reason } asks · DELETE cancels
// - GET    /api/admin/requests             requests (chanon.html → คำขอข้อมูลส่วนบุคคล)
// - POST   /api/admin/requests/:id/erase   erase the account · POST /api/admin/requests/:id/reject { note }
// - purge(): files of work that was never published, and drafts not touched, after settings retention.days; old emails after 180 days
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { Router } from 'express';
import { audit } from './audit.mjs';
import { isAdmin, publicUser, requireAdmin, requireUser } from './auth.mjs';
import { one, query, tx } from './db.mjs';
import { abs, removeDraftDir, removeSubmissionDir } from './files.mjs';
import { HttpError, str } from './http.mjs';
import { enqueue, link } from './notify.mjs';
import { limit } from './security.mjs';
import { get } from './settings.mjs';
import { loadThread, submissionOut } from './submissions.mjs';

export const router = Router();
const HOUR = 60 * 60 * 1000;

// ---- Export ----
router.get('/me/data', requireUser, limit('export', { max: 10, windowMs: HOUR }), async (req, res) => {
  const u = req.user;
  const subs = (await query('select * from submissions where sender_id = $1 order by sent_at', [u.id])).rows;
  const t = await loadThread(subs.map((s) => s.id));
  const data = {
    exportedAt: new Date().toISOString(),
    about: 'ข้อมูลส่วนบุคคลของคุณในระบบคลังข่าว มรส. (มหาวิทยาลัยราชภัฏสุราษฎร์ธานี) ตามพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562',
    account: { ...publicUser(u), createdAt: u.created_at, lastLoginAt: u.last_login_at, emailSettings: u.notify },
    sessions: (await query('select created_at, expires_at, user_agent from sessions where user_id = $1 order by created_at desc', [u.id])).rows,
    submissions: subs.map((s) => {
      const o = submissionOut(s, t, 'sender');
      return { ...o, files: o.files.map(({ name, size, mime, kind }) => ({ name, size, mime, kind })), filesRemovedAt: s.files_purged_at };
    }),
    drafts: (await query(`select d.id, d.type, d.title, d.data, d.created_at, d.updated_at,
        coalesce((select json_agg(json_build_object('kind', f.kind, 'name', f.name, 'size', f.size, 'mime', f.mime) order by f.kind, f.position)
          from draft_files f where f.draft_id = d.id), '[]') files
      from submission_drafts d where d.sender_id = $1 order by d.updated_at desc`, [u.id])).rows,
    savedNews: (await query('select n.id, n.title, s.created_at saved_at from saved_news s join news n on n.id = s.news_id where s.user_id = $1 order by s.created_at desc', [u.id])).rows,
    storiesRead: (await query(`select n.title, r.day from news_reads r join news n on n.id = r.news_id where r.reader = $1 order by r.day desc`, [`u:${u.id}`])).rows,
    calendarAssignments: (await query(`select e.title, e.start_at, e.end_at, e.location, a.duty from event_assignments a join events e on e.id = a.event_id
      where a.user_id = $1 order by e.start_at desc`, [u.id])).rows,
    serviceRequests: (await query(`select created_at, title, type, start_at, end_at, location, details, status, review_note, reviewed_at from service_requests
      where requester_id = $1 order by created_at desc`, [u.id])).rows,
    notifications: (await query('select created_at, kind, ref_id, text, read_at from notifications where user_id = $1 order by id desc', [u.id])).rows,
    emails: (await query('select created_at, kind, subject, status from email_outbox where to_email = $1 order by id desc', [u.email])).rows,
    actionsInBackOffice: (await query('select at, action, summary from audit_log where actor_id = $1 order by at desc', [u.id])).rows,
    requests: (await query('select created_at, kind, status, reason, handled_at, note from data_requests where user_id = $1 order by id desc', [u.id])).rows,
  };
  res.set('Cache-Control', 'no-store');
  res.attachment(`ข้อมูลของฉัน-ข่าว-มรส-${new Date().toISOString().slice(0, 10)}.json`);
  res.type('application/json').send(JSON.stringify(data, null, 2));
});

// ---- Deletion requests ----
const requestOut = (r) => r && { id: r.id, status: r.status, reason: r.reason, createdAt: r.created_at, handledAt: r.handled_at, note: r.note };
router.get('/me/delete-request', requireUser, async (req, res) => {
  const r = await one(`select * from data_requests where user_id = $1 order by id desc limit 1`, [req.user.id]);
  res.json({ request: requestOut(r) });
});
router.post('/me/delete-request', requireUser, limit('deleteRequest', { max: 5, windowMs: 24 * HOUR }), async (req, res) => {
  const reason = str(req.body?.reason, 1000, 'เหตุผล');
  if (isAdmin(req.user) && (await one(`select count(*)::int n from pr_team where role = 'admin'`)).n <= 1) {
    throw new HttpError(409, 'คุณเป็นผู้ดูแลระบบคนเดียว ให้สิทธิ์ผู้ดูแลระบบคนอื่นก่อนขอลบบัญชี');
  }
  const r = await tx(async (c) => {
    const open = (await c.query(`select * from data_requests where user_id = $1 and status = 'pending'`, [req.user.id])).rows[0];
    if (open) throw new HttpError(409, 'คุณมีคำขอที่รอดำเนินการอยู่แล้ว');
    const row = (await c.query(`insert into data_requests (user_id, email, reason) values ($1, $2, $3) returning *`, [req.user.id, req.user.email, reason])).rows[0];
    const admins = (await c.query(`select email from pr_team where role = 'admin'`)).rows.map((x) => x.email);
    for (const to of admins) {
      await enqueue(c, {
        kind: 'privacy.request', ref: String(row.id), to, subject: `คำขอลบข้อมูลส่วนบุคคลจาก ${req.user.email}`, title: 'มีคำขอลบข้อมูลส่วนบุคคล',
        lines: [`${req.user.name || req.user.email} (${req.user.email}) ขอให้ลบข้อมูลส่วนบุคคล`, 'ดำเนินการภายใน 30 วันนับจากวันที่ได้รับคำขอ'],
        quote: reason || undefined, button: { label: 'เปิดคำขอในหน้าตั้งค่าระบบ', href: link('chanon.html#requests') },
      });
    }
    await enqueue(c, {
      kind: 'privacy.request', ref: String(row.id), to: req.user.email, subject: 'ได้รับคำขอลบข้อมูลของคุณแล้ว', title: 'ได้รับคำขอลบข้อมูลส่วนบุคคลแล้ว',
      lines: ['ผู้ดูแลระบบจะดำเนินการและแจ้งผลภายใน 30 วัน', 'ยกเลิกคำขอได้ที่หน้านโยบายความเป็นส่วนตัวจนกว่าจะดำเนินการ'],
      button: { label: 'ดูสถานะคำขอ', href: link('privacy.html#rights') },
    });
    return row;
  });
  res.status(201).json({ request: requestOut(r) });
});
router.delete('/me/delete-request', requireUser, async (req, res) => {
  const r = await one(`update data_requests set status = 'cancelled', handled_at = now() where user_id = $1 and status = 'pending' returning *`, [req.user.id]);
  if (!r) throw new HttpError(404, 'ไม่มีคำขอที่รอดำเนินการ');
  res.json({ request: requestOut(r) });
});

// ---- Admin ----
router.get('/admin/requests', requireAdmin, async (req, res) => {
  const rows = (await query(`select r.*, u.name, u.role, u.erased_at,
      (select count(*)::int from submissions s where s.sender_id = r.user_id) submissions,
      (select count(*)::int from submissions s where s.sender_id = r.user_id and s.status = 'published') published,
      h.name handled_name
    from data_requests r left join users u on u.id = r.user_id left join users h on h.id = r.handled_by
    order by (r.status = 'pending') desc, r.id desc limit 100`)).rows;
  res.json({
    items: rows.map((r) => ({
      ...requestOut(r), email: r.email, name: r.name, role: r.role, submissions: r.submissions, published: r.published, handledBy: r.handled_name,
      due: new Date(new Date(r.created_at).getTime() + 30 * 24 * HOUR),
    })),
  });
});

// Erases an account: what identifies the person goes; published stories stay (the university's record) without the name
export async function erase(c, userId) {
  const u = (await c.query('select * from users where id = $1', [userId])).rows[0];
  if (!u || u.erased_at) return null;
  const unpublished = (await c.query(`select id from submissions where sender_id = $1 and status <> 'published'`, [userId])).rows.map((r) => r.id);
  if (unpublished.length) await c.query('delete from submissions where id = any($1)', [unpublished]);
  const drafts = (await c.query('delete from submission_drafts where sender_id = $1 returning id', [userId])).rows.map((r) => r.id);
  await c.query(`update messages set display_name = 'ผู้ส่ง (ลบข้อมูลแล้ว)' where author_id = $1 and side = 'sender'`, [userId]);
  await c.query('delete from sessions where user_id = $1', [userId]);
  await c.query('delete from saved_news where user_id = $1', [userId]);
  await c.query('delete from event_assignments where user_id = $1', [userId]);
  // Service requests stay (the office's record of its work) without the person; one still waiting will not be answered
  await c.query(`update service_requests set requester_id = null, status = case when status = 'pending' then 'cancelled' else status end where requester_id = $1`, [userId]);
  await c.query('delete from notifications where user_id = $1', [userId]);
  await c.query('delete from news_reads where reader = $1', [`u:${userId}`]);
  // Unsent emails to this address go, except the confirmation queued just before (privacy.done)
  await c.query(`delete from email_outbox where to_email = $1 and status = 'queued' and kind <> 'privacy.done'`, [u.email]);
  await c.query('delete from pr_team where email = $1', [u.email]);
  await c.query('update audit_log set actor_email = null where actor_id = $1', [userId]);
  await c.query('update news_revisions set actor_email = null, actor_name = null where actor_id = $1', [userId]);
  await c.query(`update users set email = $2, name = '', avatar_url = null, photo_path = null, first_name = null, last_name = null, phone = null, google_sub = null, unit = null, sub_unit = null, position = null,
      major = null, track = null, year = null, org = null, consent_at = null, notify = '{}', role = 'external', erased_at = now() where id = $1`,
    [userId, `erased-${randomUUID()}@deleted.invalid`]);
  return { email: u.email, unpublished, drafts, photo: u.photo_path };
}

router.post('/admin/requests/:id/erase', requireAdmin, async (req, res) => {
  const r = await one('select * from data_requests where id = $1', [Number(req.params.id) || 0]);
  if (!r) throw new HttpError(404, 'ไม่พบคำขอนี้');
  if (r.status !== 'pending') throw new HttpError(409, 'คำขอนี้ดำเนินการไปแล้ว');
  if (r.user_id === req.user.id) throw new HttpError(409, 'ให้ผู้ดูแลระบบคนอื่นดำเนินการคำขอของคุณ');
  const done = await tx(async (c) => {
    // Tell the person first, while their address is still known
    await enqueue(c, {
      kind: 'privacy.done', ref: String(r.id), to: r.email, subject: 'ลบข้อมูลส่วนบุคคลของคุณแล้ว', title: 'ลบข้อมูลส่วนบุคคลของคุณแล้ว',
      lines: ['บัญชีของคุณในระบบคลังข่าว มรส. ถูกลบข้อมูลส่วนบุคคลตามคำขอแล้ว งานที่ยังไม่ได้เผยแพร่และไฟล์ถูกลบ ข่าวที่เผยแพร่แล้วยังอยู่โดยไม่แสดงชื่อคุณ',
        'หากเข้าสู่ระบบด้วยบัญชีเดิมอีกครั้ง ระบบจะสร้างบัญชีใหม่'],
    });
    const out = await erase(c, r.user_id);
    await c.query(`update data_requests set status = 'done', handled_at = now(), handled_by = $2, note = $3 where id = $1`, [r.id, req.user.id, str(req.body?.note, 500, 'บันทึก')]);
    await audit(c, req.user, 'privacy.erase', String(r.id), `ลบข้อมูลส่วนบุคคลตามคำขอของ ${r.email}`, { unpublished: out?.unpublished.length || 0 });
    return out;
  });
  await Promise.all((done?.unpublished || []).map((id) => removeSubmissionDir(id)));
  await Promise.all((done?.drafts || []).map((id) => removeDraftDir(id)));
  if (done?.photo) await rm(abs(done.photo), { force: true });
  res.json({ ok: true });
});
router.post('/admin/requests/:id/reject', requireAdmin, async (req, res) => {
  const note = str(req.body?.note, 500, 'เหตุผล');
  if (!note) throw new HttpError(400, 'บอกเหตุผลที่ไม่ลบข้อมูล ผู้ขอจะเห็นข้อความนี้');
  const r = await one(`update data_requests set status = 'rejected', handled_at = now(), handled_by = $2, note = $3 where id = $1 and status = 'pending' returning *`, [Number(req.params.id) || 0, req.user.id, note]);
  if (!r) throw new HttpError(404, 'ไม่พบคำขอที่รอดำเนินการ');
  await tx(async (c) => {
    await enqueue(c, { kind: 'privacy.done', ref: String(r.id), to: r.email, subject: 'ผลคำขอลบข้อมูลของคุณ', title: 'ยังลบข้อมูลของคุณไม่ได้', lines: ['ผู้ดูแลระบบพิจารณาคำขอของคุณแล้ว'], quote: note, button: { label: 'ดูรายละเอียด', href: link('privacy.html#rights') } });
    await audit(c, req.user, 'privacy.reject', String(r.id), `ไม่ลบข้อมูลตามคำขอของ ${r.email}`, { note });
  });
  res.json({ ok: true });
});

// ---- Retention (hourly) ----
// Work that was never published: files go once the work has had no activity for retention.days
// (ทีม PR ลบงาน, or ขอให้แก้ไข with no reply). The work itself and its messages stay so the sender can see what happened.
export async function purge() {
  const days = get('retention').days;
  const rows = (await query(`select s.id from submissions s
    where s.files_purged_at is null and s.status in ('rejected', 'revise')
      and coalesce((select max(e.at) from submission_events e where e.submission_id = s.id), s.sent_at) < now() - make_interval(days => $1)`, [days])).rows;
  for (const { id } of rows) {
    await tx(async (c) => {
      await c.query('delete from submission_files where submission_id = $1', [id]);
      await c.query('update submissions set files_purged_at = now() where id = $1', [id]);
    });
    await removeSubmissionDir(id);
  }
  // Drafts nobody has opened for the same time go with their files
  const drafts = (await query('delete from submission_drafts where updated_at < now() - make_interval(days => $1) returning id', [days])).rows;
  await Promise.all(drafts.map((d) => removeDraftDir(d.id)));
  await query(`delete from email_outbox where created_at < now() - interval '180 days'`);
  return rows.length;
}
