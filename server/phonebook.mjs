// สมุดโทรศัพท์ (SPEC.md Phase 1, rights in access.mjs): one row per unit on phonebook.html, with a telephone number, an internal number, or both.
// A unit may sit under another (parentId: หน่วยงานหลัก → หน่วยงานย่อย), at any depth; a name is used once under the same parent.
// - GET    /api/phonebook?q=             every university role: every unit, and with q the ids that match (words of a Thai name in any order, thai.mjs)
// - POST   /api/phonebook                { unitName, parentId, phoneNumber, internalNumber, note }
// - PUT    /api/phonebook/:id            the same fields
// - DELETE /api/phonebook/:id            not while it has sub-units
// - GET    /api/phonebook/template.xlsx  the form to fill in
// - POST   /api/phonebook/import?save=1  multipart: file (.xlsx or .csv). Without save it only counts what would change,
//   and names a number column it could not find (missing).
//   One bad row stops the whole file. A unit already here is updated; an empty cell keeps its value.
//   หน่วยงานหลัก names a unit with no parent, here or in the file; a unit imported before without it moves under it.
// Telephone numbers are stored as 077-913-333 (landline) or 081-234-5678 (mobile).
// PR and admin change entries. Unit numbers only: no personal data here.
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { Router } from 'express';
import multer from 'multer';
import { requireModule, rightOf } from './access.mjs';
import { audit } from './audit.mjs';
import { query, tx } from './db.mjs';
import { UPLOAD_DIR, removeTemp } from './files.mjs';
import { HttpError, str } from './http.mjs';
import { limit, matchesName, sniff } from './security.mjs';
import { termConditions } from './thai.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^\+?[0-9][0-9 ()-]{2,29}$/;
const MAX_ROWS = 1000;
const MAX_PROBLEMS = 20;
const MAX_FILE = 2 * 1024 * 1024;
const COLUMNS = { parent: 'หน่วยงานหลัก', unitName: 'หน่วยงาน', phoneNumber: 'เบอร์โทรศัพท์', internalNumber: 'เบอร์ภายใน', note: 'หมายเหตุ' };
// Other headers people write for the same column; spaces do not count
const ALIASES = {
  parent: ['หน่วยงานต้นสังกัด', 'สังกัด'],
  unitName: ['ชื่อหน่วยงาน', 'หน่วยงานย่อย'],
  phoneNumber: ['เบอร์โทร', 'โทรศัพท์', 'โทร', 'หมายเลขโทรศัพท์', 'เบอร์ติดต่อ'],
  internalNumber: ['โทรภายใน', 'ภายใน', 'หมายเลขภายใน', 'เบอร์ต่อ'],
  note: [],
};
const plain = (s) => s.replace(/\s+/g, '');
const HEADERS = new Map(Object.entries(COLUMNS).flatMap(([k, label]) => [label, ...ALIASES[k]].map((h) => [plain(h), k])));

const edits = (right) => right === 'all' || right === 'edit';
const writer = requireModule('phonebook', 'all', 'edit');
const byName = new Intl.Collator('th');
const like = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;
const upload = multer({ dest: join(UPLOAD_DIR, 'tmp'), limits: { fileSize: MAX_FILE, files: 1, fields: 0 }, defParamCharset: 'utf8' }).single('file');
const importLimit = limit('phonebook-import', { max: 30, windowMs: 10 * 60 * 1000 });

export const router = Router();

const entryOut = (e) => ({ id: e.id, parentId: e.parent_id, unitName: e.unit_name, phoneNumber: e.phone_number, internalNumber: e.internal_number, note: e.note });

// 077913333 → 077-913-333, 0812345678 → 081-234-5678; any other number stays as typed
function formatPhone(s) {
  const d = s.replace(/\D/g, '');
  return !s.startsWith('+') && /^0\d{8,9}$/.test(d) ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : s;
}

// Throws 400 with a field → message map
function checkEntry(b) {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'ไม่พบข้อมูลหมายเลข');
  const errors = {};
  const row = { unit: str(b.unitName, 200, 'ชื่อหน่วยงาน'), parentId: b.parentId || null, phone: str(b.phoneNumber, 30, 'เบอร์โทรศัพท์'), internal: str(b.internalNumber, 30, 'เบอร์ภายใน'), note: str(b.note, 300, 'หมายเหตุ') };
  if (!row.unit) errors.unitName = 'กรอกชื่อหน่วยงาน';
  if (row.parentId && !(typeof row.parentId === 'string' && UUID.test(row.parentId))) errors.parentId = 'เลือกหน่วยงานหลักจากรายการ';
  if (row.phone && !NUMBER.test(row.phone)) errors.phoneNumber = 'กรอกเบอร์โทรศัพท์เป็นตัวเลข เช่น 077-913-333';
  if (row.internal && !NUMBER.test(row.internal)) errors.internalNumber = 'กรอกเบอร์ภายในเป็นตัวเลข เช่น 1234';
  if (!row.phone && !row.internal) errors.phoneNumber = 'กรอกเบอร์โทรศัพท์หรือเบอร์ภายในอย่างน้อย 1 เบอร์';
  if (Object.keys(errors).length) throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', errors);
  if (row.phone) row.phone = formatPhone(row.phone);
  return row;
}
const refused = (err) => {
  if (err.code === '23505') throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', { unitName: 'มีหน่วยงานชื่อนี้ภายใต้หน่วยงานหลักเดียวกันแล้ว' });
  if (err.code === '23503') throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', { parentId: 'ไม่พบหน่วยงานหลักนี้ เลือกจากรายการอีกครั้ง' });
  throw err;
};
// Throws 400 when the chosen หน่วยงานหลัก is the unit itself or sits under it
async function checkParent(c, parentId, id) {
  if (!parentId || !id) return;
  const up = await c.query(`with recursive up as (select id, parent_id from phonebook where id = $1
    union all select p.id, p.parent_id from phonebook p join up on p.id = up.parent_id) select 1 from up where id = $2`, [parentId, id]);
  if (up.rows.length) throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', { parentId: 'เลือกหน่วยงานอื่น หน่วยงานนี้อยู่ภายใต้หน่วยงานที่กำลังแก้ไข' });
}

// One condition per search term: the phrase as typed, or else all of its Thai words, in any of the four fields.
// Digits also match a telephone number without its dashes: 913333 finds 077-913-333.
function matching(q) {
  const params = [];
  const anywhere = (s) => {
    params.push(like(s));
    const p = `$${params.length}`;
    const digits = s.replace(/[\s()-]/g, '');
    let dialled = '';
    if (/^\d{3,}$/.test(digits)) {
      params.push(`%${digits}%`);
      dialled = ` or regexp_replace(phone_number, '[^0-9]', '', 'g') like $${params.length}`;
    }
    return `(unit_name ilike ${p} or phone_number ilike ${p} or internal_number ilike ${p} or note ilike ${p}${dialled})`;
  };
  const where = termConditions(q, anywhere);
  return { where: where.length ? `where ${where.join(' and ')}` : '', params };
}

// ---- File import ----
// Excel on Thai Windows saves CSV as Windows-874, not UTF-8
function decode(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-874').decode(buf); }
}
async function openSheet(f) {
  const wb = new ExcelJS.Workbook();
  const ext = extname(f.originalname).toLowerCase();
  const csv = ext === '.csv';
  const fits = csv ? (await sniff(f.path)) === null : ext === '.xlsx' && (await matchesName(f.path, f.originalname));
  if (!fits) throw new HttpError(400, 'ใช้ไฟล์ Excel (.xlsx) หรือ CSV');
  try {
    if (csv) return await wb.csv.read(Readable.from([decode(await readFile(f.path))]), { map: (v) => v });
    await wb.xlsx.readFile(f.path);
    return wb.worksheets[0];
  } catch {
    throw new HttpError(400, 'เปิดไฟล์นี้ไม่ได้ ลองใช้แบบฟอร์มที่ดาวน์โหลดจากหน้านี้');
  }
}
// Excel drops the leading zero of a phone number typed as a number: 077913333 comes back as 77913333
const restoreZero = (s) => (/^[1-9]\d{7,8}$/.test(s) ? `0${s}` : s);

// Rows of the sheet as { line, parent, unitName, phoneNumber, internalNumber, note }, found by header text,
// and the number columns the sheet does not have
function readRows(sheet) {
  if (!sheet) throw new HttpError(400, 'ไม่พบข้อมูลในไฟล์');
  const cols = {};
  sheet.getRow(1).eachCell((c, n) => { const k = HEADERS.get(plain(c.text)); if (k && !cols[k]) cols[k] = n; });
  if (!cols.unitName || (!cols.phoneNumber && !cols.internalNumber)) throw new HttpError(400, `ไม่พบหัวตาราง ใช้หัวตาราง ${Object.values(COLUMNS).join(', ')}`);
  const rows = [];
  sheet.eachRow((r, line) => {
    if (line === 1) return;
    const cell = (k) => (cols[k] ? r.getCell(cols[k]).text.trim() : '');
    const row = { line, parent: cell('parent'), unitName: cell('unitName'), phoneNumber: restoreZero(cell('phoneNumber')), internalNumber: cell('internalNumber'), note: cell('note') };
    if (row.unitName || row.phoneNumber || row.internalNumber || row.note) rows.push(row);
  });
  if (!rows.length) throw new HttpError(400, 'ไม่พบข้อมูลในไฟล์');
  if (rows.length > MAX_ROWS) throw new HttpError(400, `นำเข้าได้ครั้งละไม่เกิน ${MAX_ROWS} หน่วยงาน`);
  return { rows, missing: ['phoneNumber', 'internalNumber'].filter((k) => !cols[k]).map((k) => COLUMNS[k]) };
}

const tooMany = (problems) => new HttpError(400, `ไฟล์มีข้อมูลที่ต้องแก้ ${problems.length} แถว ยังไม่ได้นำเข้า`, { problems: problems.slice(0, MAX_PROBLEMS) });

// Throws 400 listing the lines that are wrong; a unit twice under the same หน่วยงานหลัก is one of them
function checkRows(rows) {
  const problems = [];
  const seen = new Set();
  const good = [];
  for (const r of rows) {
    try {
      const d = { ...checkEntry({ ...r, parentId: null }), parent: str(r.parent, 200, 'หน่วยงานหลัก'), line: r.line };
      const key = `${d.parent?.toLowerCase() ?? ''}|${d.unit.toLowerCase()}`;
      if (seen.has(key)) throw new HttpError(400, `มีชื่อ ${d.unit} ซ้ำในไฟล์`);
      seen.add(key);
      good.push(d);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      problems.push(`แถว ${r.line}: ${Object.values(err.details ?? {}).join(' ') || err.message}`);
    }
  }
  if (problems.length) throw tooMany(problems);
  return good;
}

// Sorts the rows into new units and changes to units here. Units with no parent come first, so a new หน่วยงานหลัก
// is saved before the units under it.
function planImport(rows, all) {
  const top = new Map(all.filter((e) => !e.parent_id).map((e) => [e.unit_name.toLowerCase(), e]));
  const under = new Map(all.map((e) => [`${e.parent_id ?? ''}|${e.unit_name.toLowerCase()}`, e]));
  const parents = new Set(all.map((e) => e.parent_id).filter(Boolean));
  const newTop = new Set(rows.filter((r) => !r.parent && !top.has(r.unit.toLowerCase())).map((r) => r.unit.toLowerCase()));
  const fresh = [], changed = [], problems = [];
  for (const r of [...rows].sort((a, b) => Number(Boolean(a.parent)) - Number(Boolean(b.parent)))) {
    const parent = r.parent ? top.get(r.parent.toLowerCase()) : null;
    if (r.parent && !parent && !newTop.has(r.parent.toLowerCase())) {
      problems.push(`แถว ${r.line}: ไม่พบหน่วยงานหลัก ${r.parent} ใส่หน่วยงานหลักเป็นแถวของตัวเองในไฟล์ก่อน`);
      continue;
    }
    const was = r.parent && !parent ? null : under.get(`${parent?.id ?? ''}|${r.unit.toLowerCase()}`);
    const loose = r.parent && !was && top.get(r.unit.toLowerCase());
    if (loose && loose.id !== parent?.id && !parents.has(loose.id)) changed.push({ ...r, id: loose.id, move: true });
    else if (!was) fresh.push(r);
    else if ((r.phone && r.phone !== was.phone_number) || (r.internal && r.internal !== was.internal_number) || (r.note && r.note !== was.note)) changed.push({ ...r, id: was.id });
  }
  if (problems.length) throw tooMany(problems);
  return { fresh, changed, top };
}

router.get('/phonebook', requireModule('phonebook'), async (req, res) => {
  const q = str(req.query.q, 100, 'คำค้น') ?? '';
  const rows = (await query(`select * from phonebook limit ${MAX_ROWS * 2}`)).rows;
  rows.sort((a, b) => byName.compare(a.unit_name, b.unit_name));
  const out = { items: rows.map(entryOut), canEdit: edits(rightOf(req.user, 'phonebook')) };
  if (q) {
    const { where, params } = matching(q);
    out.matches = (await query(`select id from phonebook ${where}`, params)).rows.map((r) => r.id);
  }
  res.json(out);
});

router.get('/phonebook/template.xlsx', writer, async (req, res) => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('สมุดโทรศัพท์');
  sheet.columns = [{ width: 36 }, { width: 40 }, { width: 20 }, { width: 14 }, { width: 32 }].map((c) => ({ ...c, style: { numFmt: '@' } })); // text: keeps the leading zero
  sheet.getRow(1).values = Object.values(COLUMNS);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="phonebook-template.xlsx"; filename*=UTF-8''${encodeURIComponent('แบบฟอร์มสมุดโทรศัพท์.xlsx')}`,
  });
  await wb.xlsx.write(res);
  res.end();
});

router.post('/phonebook/import', writer, importLimit, (req, res, next) => upload(req, res, async (err) => {
  const f = req.file;
  try {
    if (err) throw new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ใหญ่เกิน 2 MB' : 'อัปโหลดไฟล์ไม่สำเร็จ');
    if (!f) throw new HttpError(400, 'เลือกไฟล์ที่จะนำเข้า');
    const sheet = readRows(await openSheet(f));
    const rows = checkRows(sheet.rows);
    const save = req.query.save === '1';
    const result = await tx(async (c) => {
      const { fresh, changed, top } = planImport(rows, (await c.query('select * from phonebook for update')).rows);
      const counts = { added: fresh.length, updated: changed.length, unchanged: rows.length - fresh.length - changed.length };
      if (!save) return counts;
      for (const r of fresh) {
        const parentId = r.parent ? top.get(r.parent.toLowerCase()).id : null;
        const row = (await c.query('insert into phonebook (unit_name, parent_id, phone_number, internal_number, note) values ($1, $2, $3, $4, $5) returning *',
          [r.unit, parentId, r.phone, r.internal, r.note])).rows[0];
        if (!parentId) top.set(row.unit_name.toLowerCase(), row);
      }
      for (const r of changed) {
        await c.query(`update phonebook set parent_id = coalesce($5, parent_id), phone_number = coalesce($2, phone_number), internal_number = coalesce($3, internal_number),
          note = coalesce($4, note), updated_at = now() where id = $1`, [r.id, r.phone, r.internal, r.note, r.move ? top.get(r.parent.toLowerCase()).id : null]);
      }
      await audit(c, req.user, 'phonebook.import', null, `นำเข้าสมุดโทรศัพท์ เพิ่ม ${counts.added} แก้ไข ${counts.updated} หน่วยงาน`, counts);
      return counts;
    });
    res.json({ ...result, saved: save, ...(sheet.missing.length ? { missing: sheet.missing } : {}) });
  } catch (e) {
    next(e);
  } finally {
    if (f) await removeTemp([f]);
  }
}));

router.post('/phonebook', writer, async (req, res) => {
  const d = checkEntry(req.body);
  const e = await tx(async (c) => {
    const row = (await c.query('insert into phonebook (unit_name, parent_id, phone_number, internal_number, note) values ($1, $2, $3, $4, $5) returning *',
      [d.unit, d.parentId, d.phone, d.internal, d.note])).rows[0];
    await audit(c, req.user, 'phonebook.create', row.id, `เพิ่มหมายเลข ${row.unit_name}`, { parent: row.parent_id, phone: row.phone_number, internal: row.internal_number });
    return row;
  }).catch(refused);
  res.status(201).json({ entry: entryOut(e) });
});

router.put('/phonebook/:id', writer, async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบหมายเลขนี้');
  const d = checkEntry(req.body);
  const e = await tx(async (c) => {
    await checkParent(c, d.parentId, req.params.id);
    const row = (await c.query('update phonebook set unit_name = $2, parent_id = $3, phone_number = $4, internal_number = $5, note = $6, updated_at = now() where id = $1 returning *',
      [req.params.id, d.unit, d.parentId, d.phone, d.internal, d.note])).rows[0];
    if (!row) throw new HttpError(404, 'ไม่พบหมายเลขนี้');
    await audit(c, req.user, 'phonebook.update', row.id, `แก้ไขหมายเลข ${row.unit_name}`, { parent: row.parent_id, phone: row.phone_number, internal: row.internal_number });
    return row;
  }).catch(refused);
  res.json({ entry: entryOut(e) });
});

router.delete('/phonebook/:id', writer, async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบหมายเลขนี้');
  await tx(async (c) => {
    const row = (await c.query('delete from phonebook where id = $1 returning *', [req.params.id])).rows[0];
    if (!row) throw new HttpError(404, 'ไม่พบหมายเลขนี้');
    await audit(c, req.user, 'phonebook.delete', row.id, `ลบหมายเลข ${row.unit_name}`, { phone: row.phone_number, internal: row.internal_number });
  }).catch((err) => {
    if (err.code === '23503') throw new HttpError(400, 'ลบไม่ได้ เพราะยังมีหน่วยงานย่อย ย้ายหรือลบหน่วยงานย่อยก่อน');
    throw err;
  });
  res.json({ ok: true });
});
