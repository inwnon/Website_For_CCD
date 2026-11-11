// Data export for the admin (chanon.html → นำเข้า / ส่งออก): one Excel workbook per module, or all of them.
// - GET /api/admin/export               the modules the page offers
// - GET /api/admin/export/<module>.xlsx  one module; all.xlsx = every module, a sheet each
// Never exported: sessions, calendar feed tokens, Google ids, file paths under uploads/.
import ExcelJS from 'exceljs';
import { Router } from 'express';
import { ACTIONS, audit } from './audit.mjs';
import { requireAdmin } from './auth.mjs';
import { query } from './db.mjs';
import { HttpError } from './http.mjs';
import { sheet } from './reports.mjs';

export const router = Router();
router.use('/admin', requireAdmin);

const by = (alias) => `(select email from users where id = ${alias})`;
const AUDIT_ROWS = 100000;

// module → label and its sheets: [sheet name, SQL, [key, header, width][]]
const MODULES = {
  news: { label: 'ข่าว', sheets: [['ข่าว', `select n.id, n.slug, n.title, n.title_en, n.kind, n.unit, n.categories, n.audience, n.lead, n.body, n.credit,
      n.event_date, n.place, n.channels, n.featured, n.views, n.imported, n.source_url, n.published_at, n.withdrawn_at, n.withdrawn_reason, ${by('n.created_by')} created_by
      from news n order by n.published_at desc nulls last`, [
    ['id', 'รหัส', 38], ['slug', 'slug', 24], ['title', 'หัวข้อ', 48], ['title_en', 'หัวข้อ (อังกฤษ)', 32], ['kind', 'ประเภท', 12], ['unit', 'หน่วยงาน', 28],
    ['categories', 'หมวดหมู่', 24], ['audience', 'กลุ่มเป้าหมาย', 20], ['lead', 'ความนำ', 48], ['body', 'เนื้อหา', 60], ['credit', 'เครดิต', 24],
    ['event_date', 'วันที่จัดกิจกรรม', 16], ['place', 'สถานที่', 24], ['channels', 'ช่องทางเผยแพร่', 24], ['featured', 'ข่าวเด่น', 10], ['views', 'ยอดเข้าชม', 10],
    ['imported', 'นำเข้าย้อนหลัง', 12], ['source_url', 'ลิงก์ต้นฉบับ', 32], ['published_at', 'เผยแพร่เมื่อ', 20], ['withdrawn_at', 'ถอนเมื่อ', 20],
    ['withdrawn_reason', 'เหตุผลที่ถอน', 28], ['created_by', 'ผู้เผยแพร่', 28],
  ]]] },
  submissions: { label: 'งานที่ส่งเข้ามา', sheets: [['งานที่ส่งเข้ามา', `select s.ref, s.type, s.status, ${by('s.sender_id')} sender, s.unit, s.title, s.lead, s.description, s.body,
      s.event_date, s.place, s.categories, s.credit, s.note, s.sent_at, s.updated_at, s.news_id from submissions s order by s.sent_at desc nulls last`, [
    ['ref', 'เลขที่งาน', 16], ['type', 'ประเภท', 12], ['status', 'สถานะ', 14], ['sender', 'ผู้ส่ง', 28], ['unit', 'หน่วยงาน', 28], ['title', 'หัวข้อ', 48],
    ['lead', 'ความนำ', 40], ['description', 'รายละเอียด', 40], ['body', 'เนื้อหา', 60], ['event_date', 'วันที่จัดกิจกรรม', 16], ['place', 'สถานที่', 24],
    ['categories', 'หมวดหมู่', 24], ['credit', 'เครดิต', 24], ['note', 'หมายเหตุ', 32], ['sent_at', 'ส่งเมื่อ', 20], ['updated_at', 'แก้ไขล่าสุด', 20], ['news_id', 'รหัสข่าว', 38],
  ]]] },
  events: { label: 'ปฏิทินงาน', sheets: [
    ['กิจกรรม', `select e.id, e.title, e.type, e.location, e.start_at, e.end_at, e.status, e.visibility, e.description, e.internal_note, ${by('e.created_by')} created_by, e.created_at
      from events e order by e.start_at desc`, [
      ['id', 'รหัส', 38], ['title', 'ชื่อกิจกรรม', 40], ['type', 'ประเภท', 12], ['location', 'สถานที่', 28], ['start_at', 'เริ่ม', 20], ['end_at', 'สิ้นสุด', 20],
      ['status', 'สถานะ', 12], ['visibility', 'การมองเห็น', 12], ['description', 'รายละเอียด', 40], ['internal_note', 'บันทึกภายใน', 32], ['created_by', 'ผู้สร้าง', 28], ['created_at', 'สร้างเมื่อ', 20],
    ]],
    ['ผู้รับมอบหมาย', `select a.event_id, e.title, e.start_at, u.email, u.name, a.duty from event_assignments a join events e on e.id = a.event_id join users u on u.id = a.user_id
      order by e.start_at desc, u.email`, [
      ['event_id', 'รหัสกิจกรรม', 38], ['title', 'ชื่อกิจกรรม', 40], ['start_at', 'เริ่ม', 20], ['email', 'อีเมล', 28], ['name', 'ชื่อ', 28], ['duty', 'หน้าที่', 28],
    ]],
  ] },
  requests: { label: 'คำขอใช้บริการ', sheets: [['คำขอใช้บริการ', `select r.id, r.title, r.type, r.start_at, r.end_at, r.location, r.details, r.status, ${by('r.requester_id')} requester,
      r.created_at, r.review_note, ${by('r.reviewed_by')} reviewer, r.reviewed_at, r.event_id from service_requests r order by r.created_at desc`, [
    ['id', 'รหัส', 38], ['title', 'เรื่อง', 40], ['type', 'ประเภท', 14], ['start_at', 'เริ่ม', 20], ['end_at', 'สิ้นสุด', 20], ['location', 'สถานที่', 28],
    ['details', 'รายละเอียด', 40], ['status', 'สถานะ', 12], ['requester', 'ผู้ขอ', 28], ['created_at', 'ขอเมื่อ', 20], ['review_note', 'หมายเหตุผู้พิจารณา', 32],
    ['reviewer', 'ผู้พิจารณา', 28], ['reviewed_at', 'พิจารณาเมื่อ', 20], ['event_id', 'รหัสกิจกรรม', 38],
  ]]] },
  documents: { label: 'คลังเอกสาร (ข้อมูล ไม่รวมไฟล์)', sheets: [['เอกสาร', `select d.id, w.title work, d.title, d.category, d.unit_name, d.doc_date, d.tags, d.access_level, d.version,
      (select v.file_name from document_versions v where v.document_id = d.id and v.version = d.version) file_name,
      (select string_agg(u.email, ', ' order by u.email) from document_work_people p join users u on u.id = p.user_id where p.work_id = d.work_id) people,
      ${by('d.uploaded_by')} uploaded_by, d.created_at, d.archived_at from documents d left join document_works w on w.id = d.work_id order by d.created_at desc`, [
    ['id', 'รหัส', 38], ['work', 'งาน', 36], ['title', 'ชื่อเอกสาร', 40], ['category', 'หมวด', 24], ['unit_name', 'หน่วยงาน', 28], ['doc_date', 'วันที่เอกสาร', 16],
    ['tags', 'แท็ก', 24], ['access_level', 'ทีม / ส่วนตัว', 12], ['version', 'เวอร์ชัน', 10], ['file_name', 'ชื่อไฟล์', 32], ['people', 'ผู้เกี่ยวข้อง', 36],
    ['uploaded_by', 'ผู้อัปโหลด', 28], ['created_at', 'เพิ่มเมื่อ', 20], ['archived_at', 'ลบเมื่อ', 20],
  ]]] },
  phonebook: { label: 'สมุดโทรศัพท์', sheets: [['สมุดโทรศัพท์', `select g.unit_name parent, p.unit_name, p.phone_number, p.internal_number, p.note
      from phonebook p left join phonebook g on g.id = p.parent_id order by p.position nulls last, p.unit_name`, [
    ['parent', 'หน่วยงานหลัก', 36], ['unit_name', 'หน่วยงาน', 40], ['phone_number', 'หมายเลขโทรศัพท์', 20], ['internal_number', 'เบอร์ภายใน', 14], ['note', 'หมายเหตุ', 32],
  ]]] },
  users: { label: 'ผู้ใช้และบทบาท', sheets: [['ผู้ใช้', `select u.email, u.name, u.first_name, u.last_name, u.role, t.role team_role, t.unit team_unit, u.unit, u.sub_unit, u.position,
      u.phone, u.org, u.major, u.year, u.last_login_at, u.created_at, u.erased_at from users u left join pr_team t on lower(t.email) = lower(u.email)
      union all select t.email, null, null, null, null, t.role, t.unit, null, null, null, null, null, null, null, null, t.added_at, null
      from pr_team t where not exists (select 1 from users u where lower(u.email) = lower(t.email)) order by 1`, [
    ['email', 'อีเมล', 32], ['name', 'ชื่อที่แสดง', 28], ['first_name', 'ชื่อ', 18], ['last_name', 'นามสกุล', 18], ['role', 'บทบาทตามอีเมล', 14], ['team_role', 'บทบาทที่กำหนด', 14],
    ['team_unit', 'หน่วยงานของบทบาท', 24], ['unit', 'หน่วยงาน', 28], ['sub_unit', 'หน่วยงานย่อย', 24], ['position', 'ตำแหน่ง', 20], ['phone', 'โทรศัพท์', 14],
    ['org', 'องค์กร', 20], ['major', 'สาขา', 20], ['year', 'ชั้นปี', 8], ['last_login_at', 'เข้าใช้ล่าสุด', 20], ['created_at', 'เพิ่มเมื่อ', 20], ['erased_at', 'ลบข้อมูลเมื่อ', 20],
  ]]] },
  audit: { label: `ประวัติการใช้งาน (ล่าสุด ${AUDIT_ROWS.toLocaleString('en-US')} รายการ)`, sheets: [['ประวัติการใช้งาน', `select a.at, a.actor_email, a.action, a.target, a.summary
      from audit_log a order by a.at desc, a.id desc limit ${AUDIT_ROWS}`, [
    ['at', 'เวลา', 20], ['actor_email', 'ผู้ทำ', 28], ['action', 'การกระทำ', 28], ['target', 'เป้าหมาย', 38], ['summary', 'รายละเอียด', 60],
  ]]] },
};

const thTime = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
const thDay = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' });
const MAX_CELL = 32767; // Excel's limit for one cell

// A text Excel could run as a formula gets a leading apostrophe; a phone number such as +66 77 913 333 stays as it is
export const safeText = (s) => (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-][\d\s().-]*$/.test(s)) ? `'${s}` : s);

function cell(v, key) {
  if (v == null) return null;
  if (v instanceof Date) return thTime.format(v);
  if (typeof v === 'boolean') return v ? 'ใช่' : '';
  if (typeof v === 'number') return v;
  if (key === 'action') return ACTIONS[v] || v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return thDay.format(new Date(`${v}T12:00:00+07:00`));
  const s = Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return safeText(s.slice(0, MAX_CELL));
}

async function addModule(wb, mod) {
  let rows = 0;
  for (const [name, sql, cols] of mod.sheets) {
    const data = (await query(sql)).rows;
    rows += data.length;
    sheet(wb, name, cols.map(([key, header, width]) => ({ header, key, width })),
      data.map((r) => Object.fromEntries(cols.map(([key]) => [key, cell(r[key], key)]))));
  }
  return rows;
}

router.get('/admin/export', (req, res) => {
  res.json({ modules: Object.entries(MODULES).map(([key, m]) => ({ key, label: m.label })) });
});

router.get('/admin/export/:file', async (req, res) => {
  const key = /^([a-z]+)\.xlsx$/.exec(req.params.file)?.[1];
  if (!key || (key !== 'all' && !Object.hasOwn(MODULES, key))) throw new HttpError(404, 'ไม่พบข้อมูลที่จะส่งออก');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SRU News Hub';
  wb.created = new Date();
  let rows = 0;
  for (const k of key === 'all' ? Object.keys(MODULES) : [key]) rows += await addModule(wb, MODULES[k]);
  const label = key === 'all' ? 'ทุกโมดูล' : MODULES[key].label;
  await audit(null, req.user, 'data.export', key, `ส่งออกข้อมูล${label}เป็น Excel (${rows.toLocaleString('en-US')} แถว)`, { rows });
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' }).replaceAll('-', '');
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="sru-news-hub-${key}-${day}.xlsx"`,
    'Cache-Control': 'no-store',
  });
  await wb.xlsx.write(res);
  res.end();
});
