// สมุดโทรศัพท์ (SPEC.md Phase 1, rights in access.mjs): unit numbers on phonebook.html.
// - GET    /api/phonebook?q=     every university role; words of a Thai name match in any order (thai.mjs)
// - POST   /api/phonebook        { unitName, phoneType, number, note }
// - PUT    /api/phonebook/:id    the same fields
// - DELETE /api/phonebook/:id
// PR and admin change entries. Unit numbers only: no personal data here.
import { Router } from 'express';
import { requireModule, rightOf } from './access.mjs';
import { audit } from './audit.mjs';
import { query, tx } from './db.mjs';
import { HttpError, str } from './http.mjs';
import { searchTerms } from './thai.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = ['unit', 'internal'];
const NUMBER = /^\+?[0-9][0-9 ()-]{2,29}$/;
const MAX_ROWS = 1000;

const edits = (right) => right === 'all' || right === 'edit';
const writer = requireModule('phonebook', 'all', 'edit');
const byName = new Intl.Collator('th');
const like = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

export const router = Router();

const entryOut = (e) => ({ id: e.id, unitName: e.unit_name, phoneType: e.phone_type, number: e.number, note: e.note });

// Throws 400 with a field → message map
function checkEntry(b) {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'ไม่พบข้อมูลหมายเลข');
  const errors = {};
  const row = { unit: str(b.unitName, 200, 'ชื่อหน่วยงาน'), type: b.phoneType, number: str(b.number, 30, 'หมายเลข'), note: str(b.note, 300, 'หมายเหตุ') };
  if (!row.unit) errors.unitName = 'กรอกชื่อหน่วยงาน';
  if (!TYPES.includes(row.type)) errors.phoneType = 'เลือกประเภทหมายเลข';
  if (!row.number || !NUMBER.test(row.number)) errors.number = 'กรอกหมายเลขเป็นตัวเลข เช่น 0-7791-3333 หรือ 1234';
  if (Object.keys(errors).length) throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', errors);
  return row;
}

// One condition per search term: the phrase as typed, or else all of its Thai words, in any of the three fields
function matching(q) {
  const params = [];
  const anywhere = (s) => {
    params.push(like(s));
    return `(unit_name ilike $${params.length} or number ilike $${params.length} or note ilike $${params.length})`;
  };
  const where = searchTerms(q).map(({ phrase, words }) => `(${[anywhere(phrase), ...(words.length ? [`(${words.map(anywhere).join(' and ')})`] : [])].join(' or ')})`);
  return { where: where.length ? `where ${where.join(' and ')}` : '', params };
}

router.get('/phonebook', requireModule('phonebook'), async (req, res) => {
  const { where, params } = matching(str(req.query.q, 100, 'คำค้น') ?? '');
  const rows = (await query(`select * from phonebook ${where} limit ${MAX_ROWS}`, params)).rows;
  rows.sort((a, b) => byName.compare(a.unit_name, b.unit_name) || a.phone_type.localeCompare(b.phone_type) || a.number.localeCompare(b.number));
  res.json({ items: rows.map(entryOut), canEdit: edits(rightOf(req.user, 'phonebook')) });
});

router.post('/phonebook', writer, async (req, res) => {
  const d = checkEntry(req.body);
  const e = await tx(async (c) => {
    const row = (await c.query('insert into phonebook (unit_name, phone_type, number, note) values ($1, $2, $3, $4) returning *', [d.unit, d.type, d.number, d.note])).rows[0];
    await audit(c, req.user, 'phonebook.create', row.id, `เพิ่มหมายเลข ${row.unit_name}`, { number: row.number });
    return row;
  });
  res.status(201).json({ entry: entryOut(e) });
});

router.put('/phonebook/:id', writer, async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบหมายเลขนี้');
  const d = checkEntry(req.body);
  const e = await tx(async (c) => {
    const row = (await c.query('update phonebook set unit_name = $2, phone_type = $3, number = $4, note = $5, updated_at = now() where id = $1 returning *',
      [req.params.id, d.unit, d.type, d.number, d.note])).rows[0];
    if (!row) throw new HttpError(404, 'ไม่พบหมายเลขนี้');
    await audit(c, req.user, 'phonebook.update', row.id, `แก้ไขหมายเลข ${row.unit_name}`, { number: row.number });
    return row;
  });
  res.json({ entry: entryOut(e) });
});

router.delete('/phonebook/:id', writer, async (req, res) => {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'ไม่พบหมายเลขนี้');
  await tx(async (c) => {
    const row = (await c.query('delete from phonebook where id = $1 returning *', [req.params.id])).rows[0];
    if (!row) throw new HttpError(404, 'ไม่พบหมายเลขนี้');
    await audit(c, req.user, 'phonebook.delete', row.id, `ลบหมายเลข ${row.unit_name}`, { number: row.number });
  });
  res.json({ ok: true });
});
