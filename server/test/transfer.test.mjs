// Data export (chanon.html → นำเข้า / ส่งออก): admin only, one workbook per module or all, no secrets or file paths,
// text Excel could run as a formula is defused, and every export leaves a line in the usage history.
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { after, before, describe, test } from 'node:test';
import { query } from '../db.mjs';
import { safeText, whenOf } from '../transfer.mjs';
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

const TITLE = 'กิจกรรมทดสอบนำเข้า';
const xlsx = async (rows) => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('กิจกรรม').addRows([['ชื่อกิจกรรม', 'ประเภท', 'สถานที่', 'เริ่ม', 'สิ้นสุด', 'การมองเห็น', 'รายละเอียด', 'บันทึกภายใน'], ...rows]);
  return Buffer.from(await wb.xlsx.writeBuffer());
};
const sendEvents = (who, buf, save = false) => {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'events.xlsx');
  return who.call('POST', `/api/admin/import/events${save ? '?save=1' : ''}`, fd);
};
const dropEvents = async () => {
  await query('delete from events where title like $1', [`${TITLE}%`]);
  await query("delete from audit_log where action in ('event.import', 'event.create') and summary like $1", [`%${TITLE}%`]);
  await query("delete from audit_log where action = 'event.import' and actor_email = 'admin@sru.ac.th'");
};

describe('นำเข้ากิจกรรม', () => {
  before(dropEvents);
  after(dropEvents);

  test('only the admin may import or get the form', async () => {
    const buf = await xlsx([[`${TITLE} 0`, 'ประชุม', '', '2569-12-01 09:00', '2569-12-01 10:00', '', '', '']]);
    for (const as of ['pr', 'staff', 'external', 'secretary']) {
      const u = await login(as);
      assert.equal((await sendEvents(u, buf)).status, 403, as);
      assert.equal((await u.call('GET', '/api/admin/import/events/template.xlsx')).status, 403, as);
    }
    const t = await admin.call('GET', '/api/admin/import/events/template.xlsx');
    assert.equal(t.status, 200);
    assert.deepEqual(headers((await book(t.body)).getWorksheet('กิจกรรม')), ['ชื่อกิจกรรม', 'ประเภท', 'สถานที่', 'เริ่ม', 'สิ้นสุด', 'การมองเห็น', 'รายละเอียด', 'บันทึกภายใน']);
  });

  test('check, save, and a second import skips what is already there', async () => {
    const buf = await xlsx([
      [`${TITLE} 1`, 'ประชุม', 'ห้องประชุม 1', '2569-12-01 09:00', '2569-12-01 10:30', 'สาธารณะ', 'ประชุมทีม', 'โน้ต'],
      [`${TITLE} 2`, '', '', '2/12/2026 13:00', '2/12/2026 15:00', '', '', ''],
      [`${TITLE} 2`, '', '', '2/12/2026 13:00', '2/12/2026 15:00', '', '', ''],
    ]);
    const check = await sendEvents(admin, buf);
    assert.equal(check.status, 200, JSON.stringify(check.body));
    assert.deepEqual(check.body, { added: 2, skipped: 1, saved: false });
    assert.equal((await query('select 1 from events where title like $1', [`${TITLE}%`])).rows.length, 0, 'checking saves nothing');

    const save = await sendEvents(admin, buf, true);
    assert.deepEqual(save.body, { added: 2, skipped: 1, saved: true });
    const rows = (await query('select title, type, visibility, internal_note, start_at from events where title like $1 order by title', [`${TITLE}%`])).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].type, 'meeting');
    assert.equal(rows[0].visibility, 'public');
    assert.equal(rows[0].internal_note, 'โน้ต');
    assert.equal(rows[0].start_at.toISOString(), '2026-12-01T02:00:00.000Z');
    assert.equal(rows[1].type, 'other');
    assert.equal(rows[1].visibility, 'internal');
    assert.equal((await query("select 1 from audit_log where action = 'event.import' and actor_email = 'admin@sru.ac.th'")).rows.length, 1);

    assert.deepEqual((await sendEvents(admin, buf, true)).body, { added: 0, skipped: 3, saved: true });
  });

  test('a wrong row stops the whole file and names its line', async () => {
    const r = await sendEvents(admin, await xlsx([
      [`${TITLE} 3`, 'ประชุม', '', '2569-12-03 09:00', '2569-12-03 10:00', '', '', ''],
      [`${TITLE} 4`, 'ประชุม', '', '2569-12-03 11:00', '2569-12-03 10:00', '', '', ''],
      [`${TITLE} 5`, 'งานเลี้ยง', '', 'พรุ่งนี้', '2569-12-03 10:00', '', '', ''],
    ]), true);
    assert.equal(r.status, 400);
    assert.equal(r.body.details.problems.length, 2);
    assert.match(r.body.details.problems[0], /^แถว 3:/);
    assert.match(r.body.details.problems[1], /^แถว 4:/);
    assert.equal((await query('select 1 from events where title = $1', [`${TITLE} 3`])).rows.length, 0);
  });

  test('times: Excel dates, ค.ศ. or พ.ศ., and the export form', () => {
    assert.equal(whenOf(new Date(Date.UTC(2026, 11, 1, 9, 30))), '2026-12-01T09:30:00+07:00');
    assert.equal(whenOf('2569-12-01 09:00'), '2026-12-01T09:00:00+07:00');
    assert.equal(whenOf('1/12/2569 9.00'), '2026-12-01T09:00:00+07:00');
    assert.equal(whenOf('1 ธ.ค. 2569 09:00'), '2026-12-01T09:00:00+07:00');
    assert.equal(whenOf('31/4/2569 09:00'), null);
    assert.equal(whenOf(''), null);
  });
});
