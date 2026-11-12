// Data export and import for the admin (chanon.html → นำเข้า / ส่งออก), as Excel.
// - GET /api/admin/export               the modules the page offers
// - GET /api/admin/export/<module>.xlsx  one module; all.xlsx = every module, a sheet each
// Never exported: sessions, calendar feed tokens, Google ids, file paths under uploads/.
// - GET  /api/admin/import/events/template.xlsx    the form for calendar events
// - POST /api/admin/import/events[?save=1]        check the file (counts and problems); save=1 adds the events
//   A row whose รหัส is an event already there, or with the same name and start, is left as it is.
// - GET  /api/admin/import/users/template.xlsx     the form for users' roles
// - POST /api/admin/import/users[?save=1]         same for roles (pr_team): a blank role leaves the person as is, people not in the file too
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { Router } from 'express';
import multer from 'multer';
import { checkRole, applyRole, ROLE_TH } from './admin.mjs';
import { ACTIONS, audit } from './audit.mjs';
import { DEVELOPERS, requireAdmin } from './auth.mjs';
import { checkEvent, createEvent } from './calendar.mjs';
import { query, tx } from './db.mjs';
import { UPLOAD_DIR, removeTemp } from './files.mjs';
import { HttpError } from './http.mjs';
import { openSheet } from './phonebook.mjs';
import { sheet } from './reports.mjs';
import { limit } from './security.mjs';

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

// ---- Import: calendar events ----
const MAX_FILE = 2 * 1024 * 1024;
const MAX_ROWS = 500;
const MAX_PROBLEMS = 20;
const upload = multer({ dest: join(UPLOAD_DIR, 'tmp'), limits: { fileSize: MAX_FILE, files: 1, fields: 0 }, defParamCharset: 'utf8' }).single('file');
const importLimit = limit('admin-import', { max: 30, windowMs: 10 * 60 * 1000 });

// The headers of the export's กิจกรรม sheet, so an exported file comes back in
const EVENT_COLUMNS = { id: 'รหัส', title: 'ชื่อกิจกรรม', type: 'ประเภท', location: 'สถานที่', start: 'เริ่ม', end: 'สิ้นสุด', visibility: 'การมองเห็น', description: 'รายละเอียด', note: 'บันทึกภายใน' };
const HEADER_OF = Object.fromEntries(Object.entries(EVENT_COLUMNS).map(([k, h]) => [h, k]));
const TYPE_OF = { ประชุม: 'meeting', กิจกรรม: 'activity', 'ถ่ายภาพ/วิดีโอ': 'media', 'อื่นๆ': 'other', meeting: 'meeting', activity: 'activity', media: 'media', other: 'other' };
const VISIBILITY_OF = { ภายใน: 'internal', สาธารณะ: 'public', internal: 'internal', public: 'public' };
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A cell as a Bangkok time: an Excel date, 2026-12-01 09:00, 1/12/2569 09:00 or 1 ธ.ค. 2569 09:00 (the export's form)
export function whenOf(v) {
  let y, m, d, h, min;
  if (v instanceof Date) [y, m, d, h, min] = [v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate(), v.getUTCHours(), v.getUTCMinutes()]; // Excel keeps the wall clock as UTC
  else {
    const s = String(v ?? '').trim();
    let x;
    if ((x = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2})[:.](\d{2})/.exec(s))) [y, m, d, h, min] = x.slice(1).map(Number);
    else if ((x = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2})[:.](\d{2})/.exec(s))) [d, m, y, h, min] = x.slice(1).map(Number);
    else if ((x = /^(\d{1,2})\s*([ก-๙.]+)\s*(\d{4})\D+(\d{1,2})[:.](\d{2})/.exec(s))) [d, m, y, h, min] = [x[1], MONTHS.indexOf(x[2]) + 1, x[3], x[4], x[5]].map(Number);
    else return null;
  }
  if (y > 2400) y -= 543;
  if (!(m >= 1 && m <= 12 && d >= 1 && h <= 23 && min <= 59)) return null;
  const p = (n) => String(n).padStart(2, '0');
  const iso = `${y}-${p(m)}-${p(d)}T${p(h)}:${p(min)}:00+07:00`;
  return new Date(Date.parse(iso) + 7 * 3600000).getUTCDate() === d ? iso : null; // 31 เม.ย. is not a day
}
// The export put an apostrophe before text Excel could run as a formula; take it off again
const unsafe = (s) => s.replace(/^'(?=[=+\-@\t\r])/, '');

function eventRows(ws) {
  if (!ws) throw new HttpError(400, 'ไม่พบข้อมูลในไฟล์');
  let cols = null;
  const rows = [];
  ws.eachRow((r, line) => {
    if (!cols) {
      const found = {};
      r.eachCell((c, n) => { const k = HEADER_OF[c.text.trim()]; if (k) found[k] = n; });
      if (found.title && found.start) cols = found;
      return;
    }
    const text = (k) => (cols[k] ? unsafe(r.getCell(cols[k]).text.trim()) : '');
    const value = (k) => (cols[k] ? r.getCell(cols[k]).value : null);
    const row = { line, id: text('id'), title: text('title'), type: text('type'), location: text('location'), start: value('start'), end: value('end'),
      visibility: text('visibility'), description: text('description'), note: text('note') };
    if (row.title || row.start || row.end || row.location) rows.push(row);
  });
  if (!cols) throw new HttpError(400, `ไม่พบหัวตาราง ต้องมีคอลัมน์ ${EVENT_COLUMNS.title} และ ${EVENT_COLUMNS.start}`);
  if (!rows.length) throw new HttpError(400, 'ไม่พบข้อมูลในไฟล์');
  if (rows.length > MAX_ROWS) throw new HttpError(400, `นำเข้าได้ครั้งละไม่เกิน ${MAX_ROWS} กิจกรรม`);
  return rows;
}

// Every row through the calendar's own checks; any wrong row stops the whole file
async function checkEvents(rows) {
  const problems = [], good = [];
  for (const r of rows) {
    try {
      const startAt = whenOf(r.start), endAt = whenOf(r.end);
      if (!startAt) throw new HttpError(400, 'อ่านวันเวลาเริ่มไม่ได้ ใช้แบบ 2569-12-01 09:00 หรือ 1/12/2569 09:00');
      if (!endAt) throw new HttpError(400, 'อ่านวันเวลาสิ้นสุดไม่ได้ ใช้แบบ 2569-12-01 12:00 หรือ 1/12/2569 12:00');
      const d = await checkEvent({ title: r.title, type: r.type ? TYPE_OF[r.type.replace(/\s/g, '')] ?? r.type : 'other', location: r.location || null, startAt, endAt,
        visibility: r.visibility ? VISIBILITY_OF[r.visibility] ?? r.visibility : 'internal', description: r.description || null, internalNote: r.note || null, assignees: [] });
      good.push({ ...d, id: UUID.test(r.id) ? r.id : null, line: r.line });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      problems.push(`แถว ${r.line}: ${Object.values(err.details ?? {}).join(' ') || err.message}`);
    }
  }
  if (problems.length) throw new HttpError(400, `ไฟล์มีข้อมูลที่ต้องแก้ ${problems.length} แถว ยังไม่ได้นำเข้า`, { problems: problems.slice(0, MAX_PROBLEMS) });
  return good;
}

router.get('/admin/import/events/template.xlsx', async (req, res) => {
  const wb = new ExcelJS.Workbook();
  const cols = Object.entries(EVENT_COLUMNS).filter(([k]) => k !== 'id');
  sheet(wb, 'กิจกรรม', cols.map(([key, header]) => ({ header, key, width: ['title', 'description', 'note'].includes(key) ? 40 : 20, style: { numFmt: '@' } })), []);
  sheet(wb, 'วิธีกรอก', [{ header: 'ช่อง', key: 'k', width: 18 }, { header: 'วิธีกรอก', key: 'v', width: 90 }], [
    { k: EVENT_COLUMNS.title, v: 'จำเป็น ไม่เกิน 200 ตัวอักษร' },
    { k: EVENT_COLUMNS.type, v: 'ประชุม, กิจกรรม, ถ่ายภาพ/วิดีโอ หรือ อื่น ๆ (เว้นว่าง = อื่น ๆ)' },
    { k: `${EVENT_COLUMNS.start} / ${EVENT_COLUMNS.end}`, v: 'จำเป็น เช่น 2569-12-01 09:00 หรือ 1/12/2569 09:00 (ปี พ.ศ. หรือ ค.ศ.) เวลาสิ้นสุดต้องหลังเวลาเริ่ม' },
    { k: EVENT_COLUMNS.visibility, v: 'ภายใน หรือ สาธารณะ (เว้นว่าง = ภายใน) กิจกรรมสาธารณะแสดงบนหน้าแรก' },
    { k: EVENT_COLUMNS.note, v: 'เห็นเฉพาะทีม PR และผู้ดูแลระบบ' },
    { k: 'กิจกรรมซ้ำ', v: 'แถวที่ชื่อและเวลาเริ่มตรงกับกิจกรรมที่มีอยู่จะข้าม ไม่สร้างซ้ำ เพิ่มผู้รับมอบหมายในหน้าปฏิทินหลังนำเข้า' },
  ]);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="events-template.xlsx"; filename*=UTF-8''${encodeURIComponent('แบบฟอร์มนำเข้ากิจกรรม.xlsx')}`,
  });
  await wb.xlsx.write(res);
  res.end();
});

router.post('/admin/import/events', importLimit, (req, res, next) => upload(req, res, async (err) => {
  const f = req.file;
  try {
    if (err) throw new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ใหญ่เกิน 2 MB' : 'อัปโหลดไฟล์ไม่สำเร็จ');
    if (!f) throw new HttpError(400, 'เลือกไฟล์ที่จะนำเข้า');
    const rows = await checkEvents(eventRows(await openSheet(f)));
    const save = req.query.save === '1';
    const result = await tx(async (c) => {
      const there = (await c.query('select id, title, start_at from events where id = any($1::uuid[]) or (title = any($2) and start_at = any($3::timestamptz[]))',
        [rows.map((r) => r.id).filter(Boolean), rows.map((r) => r.title), rows.map((r) => r.start)])).rows;
      const ids = new Set(there.map((e) => e.id)), keys = new Set(there.map((e) => `${e.title}|${e.start_at.getTime()}`));
      const fresh = [];
      for (const r of rows) {
        const key = `${r.title}|${new Date(r.start).getTime()}`;
        if ((r.id && ids.has(r.id)) || keys.has(key)) continue;
        keys.add(key); // the same event twice in the file is added once
        fresh.push(r);
      }
      const counts = { added: fresh.length, skipped: rows.length - fresh.length };
      if (!save) return counts;
      for (const r of fresh) await createEvent(c, r, req.user);
      await audit(c, req.user, 'event.import', null, `นำเข้ากิจกรรมจากไฟล์ เพิ่ม ${counts.added} ข้าม ${counts.skipped} กิจกรรม`, counts);
      return counts;
    });
    res.json({ ...result, saved: save });
  } catch (e) {
    next(e);
  } finally {
    if (f) await removeTemp([f]);
  }
}));

// ---- Import: users' roles (pr_team) ----
// The headers of the export's ผู้ใช้ sheet, so an exported file comes back in. A blank role leaves that person as is;
// ตามโดเมนอีเมล (default) takes a special role away. People not in the file are not touched.
const USER_COLUMNS = { email: 'อีเมล', role: 'บทบาทที่กำหนด', unit: 'หน่วยงานของบทบาท' };
const USER_HEADER_OF = Object.fromEntries(Object.entries(USER_COLUMNS).map(([k, h]) => [h, k]));
const ROLE_OF = Object.fromEntries(Object.entries(ROLE_TH).flatMap(([code, th]) => [[code, code], [th.replace(/\s/g, ''), code]]));

function userRows(ws) {
  if (!ws) throw new HttpError(400, 'ไม่พบข้อมูลในไฟล์');
  let cols = null;
  const rows = [];
  ws.eachRow((r, line) => {
    if (!cols) {
      const found = {};
      r.eachCell((c, n) => { const k = USER_HEADER_OF[c.text.trim()]; if (k) found[k] = n; });
      if (found.email && found.role) cols = found;
      return;
    }
    const text = (k) => (cols[k] ? unsafe(r.getCell(cols[k]).text.trim()) : '');
    const row = { line, email: text('email').toLowerCase(), role: text('role'), unit: text('unit') };
    if (row.email || row.role || row.unit) rows.push(row);
  });
  if (!cols) throw new HttpError(400, `ไม่พบหัวตาราง ต้องมีคอลัมน์ ${USER_COLUMNS.email} และ ${USER_COLUMNS.role}`);
  if (!rows.length) throw new HttpError(400, 'ไม่พบข้อมูลในไฟล์');
  if (rows.length > MAX_ROWS) throw new HttpError(400, `นำเข้าได้ครั้งละไม่เกิน ${MAX_ROWS} คน`);
  return rows;
}

// Every row through the same checks as the role buttons; any wrong row stops the whole file.
// Rows without a role and developer accounts (always top rights) are left out, not refused, so an export comes back in.
function checkUsers(rows, actor) {
  const problems = [], good = [], seen = new Set();
  let blank = 0;
  for (const r of rows) {
    try {
      if (r.email && seen.has(r.email)) throw new HttpError(400, 'อีเมลนี้มีซ้ำในไฟล์');
      seen.add(r.email);
      if (!r.role) { if (!r.email) throw new HttpError(400, 'อีเมลไม่ถูกต้อง'); blank++; continue; }
      if (DEVELOPERS.has(r.email)) { blank++; continue; }
      good.push(checkRole(actor, r.email, ROLE_OF[r.role.replace(/\s/g, '')] ?? r.role, r.unit));
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      problems.push(`แถว ${r.line}: ${err.message}`);
    }
  }
  if (problems.length) throw new HttpError(400, `ไฟล์มีข้อมูลที่ต้องแก้ ${problems.length} แถว ยังไม่ได้นำเข้า`, { problems: problems.slice(0, MAX_PROBLEMS) });
  return { good, blank };
}

router.get('/admin/import/users/template.xlsx', async (req, res) => {
  const wb = new ExcelJS.Workbook();
  sheet(wb, 'ผู้ใช้', Object.entries(USER_COLUMNS).map(([key, header]) => ({ header, key, width: key === 'role' ? 24 : 36, style: { numFmt: '@' } })), []);
  sheet(wb, 'วิธีกรอก', [{ header: 'ช่อง', key: 'k', width: 18 }, { header: 'วิธีกรอก', key: 'v', width: 90 }], [
    { k: USER_COLUMNS.email, v: 'จำเป็น อีเมล Google ของคนนั้น' },
    { k: USER_COLUMNS.role, v: `${Object.values(ROLE_TH).filter((t) => t !== ROLE_TH.default).join(', ')} หรือ ${ROLE_TH.default} (ยกเลิกบทบาทพิเศษ) เว้นว่าง = ไม่เปลี่ยน` },
    { k: USER_COLUMNS.unit, v: `จำเป็นเฉพาะ ${ROLE_TH.coordinator}: ชื่อหน่วยงานตามโครงสร้างองค์กรของระบบ` },
    { k: 'คนที่ไม่อยู่ในไฟล์', v: 'บทบาทเดิมยังอยู่ ไม่ถูกเปลี่ยน บัญชีผู้พัฒนาระบบมีสิทธิ์สูงสุดเสมอและไม่ถูกเปลี่ยน' },
  ]);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="users-template.xlsx"; filename*=UTF-8''${encodeURIComponent('แบบฟอร์มนำเข้าบทบาทผู้ใช้.xlsx')}`,
  });
  await wb.xlsx.write(res);
  res.end();
});

router.post('/admin/import/users', importLimit, (req, res, next) => upload(req, res, async (err) => {
  const f = req.file;
  try {
    if (err) throw new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ใหญ่เกิน 2 MB' : 'อัปโหลดไฟล์ไม่สำเร็จ');
    if (!f) throw new HttpError(400, 'เลือกไฟล์ที่จะนำเข้า');
    const { good, blank } = checkUsers(userRows(await openSheet(f)), req.user);
    const save = req.query.save === '1';
    const result = await tx(async (c) => {
      const now = new Map((await c.query('select email, role::text, unit from pr_team where email = any($1)', [good.map((r) => r.email)])).rows.map((t) => [t.email, t]));
      const counts = { added: 0, changed: 0, removed: 0, unchanged: blank };
      const todo = good.filter((r) => {
        const t = now.get(r.email);
        const kind = r.role === 'default' ? (t ? 'removed' : 'unchanged') : !t ? 'added' : t.role !== r.role || (t.unit ?? null) !== r.unit ? 'changed' : 'unchanged';
        counts[kind]++;
        return kind !== 'unchanged';
      });
      if (!save) return counts;
      for (const r of todo) await applyRole(c, req.user, r);
      await audit(c, req.user, 'role.import', null, `นำเข้าบทบาทจากไฟล์ เพิ่ม ${counts.added} เปลี่ยน ${counts.changed} ยกเลิก ${counts.removed} คน`, counts);
      return counts;
    });
    res.json({ ...result, saved: save });
  } catch (e) {
    next(e);
  } finally {
    if (f) await removeTemp([f]);
  }
}));
