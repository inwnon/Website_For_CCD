// Data export (chanon.html → นำเข้า / ส่งออก): admin only, one workbook per module or all, no secrets or file paths,
// text Excel could run as a formula is defused, and every export leaves a line in the usage history.
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { after, before, describe, test } from 'node:test';
import { query } from '../db.mjs';
import { safeText } from '../transfer.mjs';
import { login } from './helpers.mjs';

const UNIT = '=HYPERLINK("http://evil.test","หน่วยทดสอบส่งออก")';
let admin;
const book = async (buf) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; };
const headers = (ws) => ws.getRow(1).values.filter(Boolean);
const clean = async () => {
  await query('delete from phonebook where unit_name = $1', [UNIT]);
  await query("delete from audit_log where action = 'data.export' and actor_email = 'admin@sru.ac.th'");
};

before(async () => {
  admin = await login('admin');
  await clean();
  await query("insert into phonebook (unit_name, phone_number) values ($1, '077913333')", [UNIT]);
});
after(clean);

describe('ส่งออกข้อมูล', () => {
  test('only the admin may export', async () => {
    for (const as of ['pr', 'staff', 'student', 'external', 'secretary', 'executive', 'coordinator']) {
      const u = await login(as);
      assert.equal((await u.call('GET', '/api/admin/export')).status, 403, as);
      assert.equal((await u.call('GET', '/api/admin/export/phonebook.xlsx')).status, 403, as);
    }
  });

  test('an unknown module is not found', async () => {
    assert.equal((await admin.call('GET', '/api/admin/export/sessions.xlsx')).status, 404);
    assert.equal((await admin.call('GET', '/api/admin/export/phonebook.csv')).status, 404);
  });

  test('one module: a workbook, the formula defused, a line in the usage history', async () => {
    const r = await admin.call('GET', '/api/admin/export/phonebook.xlsx');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /spreadsheetml/);
    const ws = (await book(r.body)).getWorksheet('สมุดโทรศัพท์');
    const names = ws.getColumn(2).values;
    assert.ok(names.includes(`'${UNIT}`), 'the formula starts with an apostrophe');
    assert.ok(!names.includes(UNIT));
    assert.ok(ws.getColumn(3).values.includes('077913333'), 'the leading zero stays');
    const log = await query("select details from audit_log where action = 'data.export' and target = 'phonebook' and actor_email = 'admin@sru.ac.th'");
    assert.equal(log.rows.length, 1);
  });

  test('all modules: a sheet each, no secrets or file paths', async () => {
    const list = (await admin.call('GET', '/api/admin/export')).body.modules.map((m) => m.key);
    assert.deepEqual(list, ['news', 'submissions', 'events', 'requests', 'documents', 'phonebook', 'users', 'audit']);
    const r = await admin.call('GET', '/api/admin/export/all.xlsx');
    assert.equal(r.status, 200);
    const wb = await book(r.body);
    const sheets = wb.worksheets.map((ws) => ws.name);
    for (const s of ['ข่าว', 'งานที่ส่งเข้ามา', 'กิจกรรม', 'ผู้รับมอบหมาย', 'คำขอใช้บริการ', 'เอกสาร', 'สมุดโทรศัพท์', 'ผู้ใช้', 'ประวัติการใช้งาน']) assert.ok(sheets.includes(s), s);
    const all = wb.worksheets.flatMap(headers).join(' ');
    assert.doesNotMatch(all, /token|google|path|รหัสผ่าน/i);
    let paths = 0;
    wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => { if (/uploads[\\/]/.test(String(c.value))) paths++; })));
    assert.equal(paths, 0);
  });

  test('a phone number with + stays as it is; other leading signs are defused', () => {
    assert.equal(safeText('+66 77 913 333'), '+66 77 913 333');
    assert.equal(safeText('-'), '-');
    assert.equal(safeText('+cmd|calc'), "'+cmd|calc");
    assert.equal(safeText('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(safeText('ข่าว'), 'ข่าว');
  });
});
