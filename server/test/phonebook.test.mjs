// สมุดโทรศัพท์ (SPEC.md §2, §4): who sees and changes what, Thai search, validation, file import and audit_log.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import ExcelJS from 'exceljs';
import { one, query } from '../db.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { anon, login } from './helpers.mjs';

const UNIT = 'ทดสอบสมุดโทรศัพท์';
const HEAD = ['หน่วยงาน', 'เบอร์โทรศัพท์', 'เบอร์ภายใน', 'หมายเหตุ'];
const TEMPLATE = ['หน่วยงานหลัก', ...HEAD];
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
let serial = 0;
const unit = (name = 'กองกลาง') => `${UNIT} ${name} ${++serial}`;
const entry = (over = {}) => ({ unitName: unit(), phoneNumber: '0-7791-3333', internalNumber: '1234', note: 'เวลาราชการ', ...over });

let snap, pr, admin, student, secretary, executive, staff, coordinator, external;
const create = async (over) => {
  const r = await pr.call('POST', '/api/phonebook', entry(over));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.entry;
};
const logged = async (action, id) => (await one('select count(*)::int n from audit_log where action = $1 and target = $2', [action, id])).n;
const find = async (who, q) => (await who.call('GET', `/api/phonebook?q=${encodeURIComponent(q)}`)).body.matches;
const stored = (name) => one('select * from phonebook where unit_name = $1', [name]);

const sheet = async (rows, head = HEAD) => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('สมุด').addRows([head, ...rows]);
  return Buffer.from(await wb.xlsx.writeBuffer());
};
const send = (who, buf, name = 'phones.xlsx', save = false, type = XLSX) => {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), name);
  return who.call('POST', `/api/phonebook/import${save ? '?save=1' : ''}`, fd);
};
// Excel on Thai Windows saves CSV as Windows-874
const thaiBytes = (s) => Buffer.from([...s].map((c) => { const n = c.codePointAt(0); return n >= 0x0e01 && n <= 0x0e5b ? n - 0x0e00 + 0xa0 : n; }));

before(async () => {
  snap = await snapshot();
  [pr, admin, student, secretary, executive, staff, coordinator, external] = await Promise.all(['pr', 'admin', 'student', 'secretary', 'executive', 'staff', 'coordinator', 'external'].map(login));
});
after(async () => {
  await query('delete from phonebook where unit_name like $1', [`${UNIT}%`]);
  await restore(snap);
});

describe('who may do what', () => {
  test('every university role reads; only PR and admin may edit', async () => {
    await create();
    for (const who of [pr, admin]) assert.equal((await who.call('GET', '/api/phonebook')).body.canEdit, true);
    for (const who of [student, secretary, executive, staff, coordinator]) {
      const r = await who.call('GET', '/api/phonebook');
      assert.equal(r.status, 200);
      assert.equal(r.body.canEdit, false);
      assert.ok(r.body.items.length > 0);
    }
  });
  test('external and the public get nothing', async () => {
    const e = await create();
    assert.equal((await external.call('GET', '/api/phonebook')).status, 403);
    assert.equal((await anon.call('GET', '/api/phonebook')).status, 401);
    for (const [method, path] of [['POST', '/api/phonebook'], ['PUT', `/api/phonebook/${e.id}`], ['DELETE', `/api/phonebook/${e.id}`]]) {
      assert.equal((await external.call(method, path, entry())).status, 403);
      assert.equal((await anon.call(method, path, entry())).status, 401);
    }
  });
  test('readers cannot change an entry, even with its id', async () => {
    const e = await create();
    for (const who of [student, secretary, executive, staff, coordinator]) {
      assert.equal((await who.call('POST', '/api/phonebook', entry())).status, 403);
      assert.equal((await who.call('PUT', `/api/phonebook/${e.id}`, entry({ phoneNumber: '1111' }))).status, 403);
      assert.equal((await who.call('DELETE', `/api/phonebook/${e.id}`)).status, 403);
    }
    assert.equal((await one('select phone_number from phonebook where id = $1', [e.id])).phone_number, e.phoneNumber);
  });
  test('only PR and admin reach the template and the import', async () => {
    const buf = await sheet([[unit(), '1234', '', '']]);
    for (const who of [student, secretary, executive, staff, coordinator, external]) {
      assert.equal((await who.call('GET', '/api/phonebook/template.xlsx')).status, 403);
      assert.equal((await send(who, buf, 'phones.xlsx', true)).status, 403);
    }
    assert.equal((await anon.call('GET', '/api/phonebook/template.xlsx')).status, 401);
    assert.equal((await send(anon, buf, 'phones.xlsx', true)).status, 401);
  });
});

describe('changing entries', () => {
  test('create, update and delete, each in audit_log', async () => {
    const e = await create();
    assert.deepEqual([e.phoneNumber, e.internalNumber], ['077-913-333', '1234']);
    assert.equal(await logged('phonebook.create', e.id), 1);

    const put = await pr.call('PUT', `/api/phonebook/${e.id}`, entry({ phoneNumber: null, internalNumber: '4321', note: null }));
    assert.equal(put.status, 200);
    assert.deepEqual([put.body.entry.phoneNumber, put.body.entry.internalNumber, put.body.entry.note], [null, '4321', null]);
    assert.equal(await logged('phonebook.update', e.id), 1);

    assert.equal((await admin.call('DELETE', `/api/phonebook/${e.id}`)).status, 200);
    assert.equal(await one('select 1 from phonebook where id = $1', [e.id]), null);
    assert.equal(await logged('phonebook.delete', e.id), 1);
  });
  test('a unit may have either number alone, but not neither', async () => {
    assert.equal((await create({ internalNumber: null })).internalNumber, null);
    assert.equal((await create({ phoneNumber: null })).phoneNumber, null);
    const r = await pr.call('POST', '/api/phonebook', entry({ phoneNumber: ' ', internalNumber: '' }));
    assert.equal(r.status, 400);
    assert.ok(r.body.details.phoneNumber);
  });
  test('a unit name is used once, whatever the case', async () => {
    const e = await create({ unitName: `${UNIT} Office ${++serial}` });
    const again = await pr.call('POST', '/api/phonebook', entry({ unitName: e.unitName.toUpperCase() }));
    assert.equal(again.status, 400);
    assert.ok(again.body.details.unitName);
    const other = await create();
    const moved = await pr.call('PUT', `/api/phonebook/${other.id}`, entry({ unitName: e.unitName }));
    assert.equal(moved.status, 400);
    assert.ok(moved.body.details.unitName);
  });
  test('an unknown or malformed id is 404', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'nope']) {
      assert.equal((await pr.call('PUT', `/api/phonebook/${id}`, entry())).status, 404);
      assert.equal((await pr.call('DELETE', `/api/phonebook/${id}`)).status, 404);
    }
  });
  test('invalid input is refused with the field that is wrong', async () => {
    const wrong = async (over, field) => {
      const r = await pr.call('POST', '/api/phonebook', entry(over));
      assert.equal(r.status, 400, JSON.stringify(over));
      assert.ok(r.body.details?.[field], JSON.stringify(r.body));
    };
    await wrong({ unitName: '  ' }, 'unitName');
    await wrong({ phoneNumber: 'โทรหาสมชาย' }, 'phoneNumber');
    await wrong({ internalNumber: '12' }, 'internalNumber');
    assert.equal((await pr.call('POST', '/api/phonebook', 'x')).status, 400);
  });
  test('text that is too long or not text is refused', async () => {
    assert.equal((await pr.call('POST', '/api/phonebook', entry({ unitName: 'ก'.repeat(201) }))).status, 400);
    assert.equal((await pr.call('POST', '/api/phonebook', entry({ note: { a: 1 } }))).status, 400);
  });
});

describe('search', () => {
  test('finds a unit by a word inside its Thai name, by either number and by note', async () => {
    const e = await create({ unitName: `${UNIT} สำนักงานอธิการบดี ${++serial}`, phoneNumber: '077-919-876', internalNumber: '5544', note: 'ห้องประชุมใหญ่' });
    for (const q of ['อธิการบดี', 'สำนักงาน อธิการบดี', '9876', '919876', '5544', 'ประชุมใหญ่']) assert.ok((await find(staff, q)).includes(e.id), q);
    assert.deepEqual(await find(staff, 'ไม่มีหน่วยงานนี้แน่นอน'), []);
  });
  test('% and _ are plain characters', async () => {
    await create();
    assert.deepEqual(await find(staff, '%'), []);
    assert.deepEqual(await find(staff, '_'), []);
  });
});

describe('importing a file', () => {
  test('the template has the columns the import reads, and imports empty', async () => {
    const r = await pr.call('GET', '/api/phonebook/template.xlsx');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body);
    assert.deepEqual(/** @type {any[]} */ (wb.worksheets[0].getRow(1).values).slice(1), TEMPLATE);
    const preview = await send(pr, r.body);
    assert.equal(preview.status, 400, 'nothing to import');
  });
  test('a first pass only counts; saving adds, updates and writes one audit_log entry', async () => {
    const old = await create({ phoneNumber: '0-7791-1111', internalNumber: '1111', note: 'เดิม' });
    const same = await create();
    const [a, b] = [unit('ใหม่'), unit('ใหม่')];
    const buf = await sheet([[a, '0-7791-2222', '2222', 'หมายเหตุ'], [b, '', '3333', ''], [old.unitName, '0-7791-4444', '', ''], [same.unitName, same.phoneNumber, same.internalNumber, same.note]]);

    const preview = await send(pr, buf);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body, { added: 2, updated: 1, unchanged: 1, saved: false });
    assert.equal(await stored(a), null, 'nothing saved yet');

    const saved = await send(pr, buf, 'phones.xlsx', true);
    assert.deepEqual(saved.body, { added: 2, updated: 1, unchanged: 1, saved: true });
    assert.equal((await stored(a)).phone_number, '077-912-222');
    assert.equal((await stored(b)).phone_number, null);
    const row = await stored(old.unitName);
    assert.deepEqual([row.phone_number, row.internal_number, row.note], ['077-914-444', '1111', 'เดิม'], 'an empty cell keeps what is there');
    assert.equal((await one(`select count(*)::int n from audit_log where action = 'phonebook.import' and actor_email = 'pr@sru.ac.th' and at >= $1`, [snap.at])).n, 1);
  });
  test('a bad row names its line and saves nothing', async () => {
    const good = unit();
    const dup = unit();
    const buf = await sheet([[good, '0-7791-2222', '', ''], ['', '1234', '', ''], [unit(), 'โทรหาสมชาย', '', ''], [unit(), '', '', ''], [dup, '1234', '', ''], [dup, '5678', '', '']]);
    const r = await send(pr, buf, 'phones.xlsx', true);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.details.problems.map((p) => p.match(/^แถว (\d+)/)[1]), ['3', '4', '5', '7']);
    assert.equal(await stored(good), null);
  });
  test('columns may come in any order; numbers Excel stored as numbers keep their zero', async () => {
    const name = unit();
    const r = await send(pr, await sheet([['เวลาราชการ', 1234, 77913333, name]], ['หมายเหตุ', 'เบอร์ภายใน', 'เบอร์โทรศัพท์', 'หน่วยงาน']), 'phones.xlsx', true);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = await stored(name);
    assert.deepEqual([row.phone_number, row.internal_number, row.note], ['077-913-333', '1234', 'เวลาราชการ']);
  });
  test('reads CSV in UTF-8 and in Windows-874', async () => {
    const [a, b] = [unit('ยูทีเอฟ'), unit('วินโดวส์')];
    const line = (n) => `${HEAD.join(',')}\r\n${n},0-7791-3333,1234,เวลาราชการ\r\n`;
    assert.equal((await send(pr, Buffer.concat([BOM, Buffer.from(line(a))]), 'phones.csv', true, 'text/csv')).status, 200);
    assert.equal((await send(pr, thaiBytes(line(b)), 'phones.csv', true, 'text/csv')).status, 200);
    for (const n of [a, b]) assert.deepEqual([(await stored(n))?.phone_number, (await stored(n))?.note], ['077-913-333', 'เวลาราชการ']);
  });
  test('refuses other files, a wrong header and a file that is too big', async () => {
    assert.equal((await send(pr, Buffer.from('not a workbook'), 'phones.xlsx')).status, 400);
    assert.equal((await send(pr, await sheet([]), 'phones.pdf')).status, 400);
    assert.equal((await send(pr, await sheet([]), 'phones.csv')).status, 400, 'binary named .csv');
    assert.equal((await send(pr, await sheet([[unit(), '1234']], ['ชื่อ', 'โทร']))).status, 400);
    assert.equal((await send(pr, Buffer.alloc(3 * 1024 * 1024, 'a'), 'phones.csv')).status, 413);
    const fd = new FormData();
    assert.equal((await pr.call('POST', '/api/phonebook/import', fd)).status, 400);
  });
  test('refuses more rows than the limit', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => [`${UNIT} ${i}`, '1234', '', '']);
    assert.equal((await send(pr, await sheet(rows))).status, 400);
  });
});

describe('หน่วยงานหลัก and หน่วยงานย่อย', () => {
  test('a unit sits under another; the same name may sit under two parents', async () => {
    const [a, b] = [await create({ unitName: unit('คณะ') }), await create({ unitName: unit('คณะ') })];
    const name = unit('สำนักงานคณบดี');
    const subA = await create({ unitName: name, parentId: a.id });
    const subB = await create({ unitName: name, parentId: b.id });
    assert.deepEqual([subA.parentId, subB.parentId], [a.id, b.id]);
    const twice = await pr.call('POST', '/api/phonebook', entry({ unitName: name, parentId: a.id }));
    assert.equal(twice.status, 400);
    assert.ok(twice.body.details.unitName);
    const items = (await staff.call('GET', '/api/phonebook')).body.items;
    assert.equal(items.find((x) => x.id === subA.id).parentId, a.id);
    assert.ok((await find(staff, name)).includes(subB.id));
  });
  test('a unit cannot go under itself or under its own sub-unit; an unknown parent is refused', async () => {
    const top = await create();
    const sub = await create({ parentId: top.id });
    for (const parentId of [top.id, sub.id]) {
      const r = await pr.call('PUT', `/api/phonebook/${top.id}`, entry({ unitName: top.unitName, parentId }));
      assert.equal(r.status, 400, parentId);
      assert.ok(r.body.details.parentId);
    }
    for (const parentId of ['00000000-0000-4000-8000-000000000000', 'nope', 5]) {
      const r = await pr.call('POST', '/api/phonebook', entry({ parentId }));
      assert.equal(r.status, 400, String(parentId));
      assert.ok(r.body.details.parentId);
    }
  });
  test('a unit with sub-units is not deleted; moving it is logged', async () => {
    const top = await create();
    const sub = await create({ parentId: top.id });
    assert.equal((await pr.call('DELETE', `/api/phonebook/${top.id}`)).status, 400);
    const moved = await pr.call('PUT', `/api/phonebook/${sub.id}`, entry({ unitName: sub.unitName, parentId: null }));
    assert.equal(moved.body.entry.parentId, null);
    assert.equal(await logged('phonebook.update', sub.id), 1);
    assert.equal((await pr.call('DELETE', `/api/phonebook/${top.id}`)).status, 200);
  });
});

describe('telephone numbers', () => {
  test('are stored as 077-913-333 or 081-234-5678; other numbers stay as typed', async () => {
    for (const [typed, saved] of [['077913333', '077-913-333'], ['0 7791 3333', '077-913-333'], ['0812345678', '081-234-5678'], ['+66 77 913 333', '+66 77 913 333'], ['1669', '1669']]) {
      assert.equal((await create({ phoneNumber: typed })).phoneNumber, saved, typed);
    }
  });
});

describe('importing units under a หน่วยงานหลัก', () => {
  const GROUPED = ['หน่วยงานหลัก', ...HEAD];
  test('a new หน่วยงานหลัก and its units come in together; a unit imported before moves under it', async () => {
    const [top, sub, loose] = [unit('คณะ'), unit('สำนักงานคณบดี'), unit('สาขา')];
    const before = await create({ unitName: loose, phoneNumber: '077913000' });
    const buf = await sheet([['', top, '077913100', '', ''], [top, sub, '077913101', '', ''], [top, loose, '', '3102', '']], GROUPED);
    const preview = await send(pr, buf);
    assert.deepEqual(preview.body, { added: 2, updated: 1, unchanged: 0, saved: false });
    assert.equal((await send(pr, buf, 'phones.xlsx', true)).status, 200);
    const parent = await stored(top);
    assert.equal(parent.parent_id, null);
    assert.equal((await stored(sub)).parent_id, parent.id);
    const moved = await one('select * from phonebook where id = $1', [before.id]);
    assert.deepEqual([moved.parent_id, moved.phone_number, moved.internal_number], [parent.id, '077-913-000', '3102']);
  });
  test('a หน่วยงานหลัก that is nowhere is a bad row', async () => {
    const r = await send(pr, await sheet([[unit('ไม่มี'), unit(), '1234', '', '']], GROUPED), 'phones.xlsx', true);
    assert.equal(r.status, 400);
    assert.match(r.body.details.problems[0], /^แถว 2: ไม่พบหน่วยงานหลัก/);
  });
  test('reads headers written another way, and names a number column it cannot find', async () => {
    const name = unit();
    const r = await send(pr, await sheet([[name, '1234']], ['ชื่อหน่วยงาน', 'เบอร์ ภายใน']));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.missing, ['เบอร์โทรศัพท์']);
    const ok = await send(pr, await sheet([[name, '077913333', '1234']], ['หน่วยงาน', 'เบอร์โทร', 'โทรภายใน']), 'phones.xlsx', true);
    assert.equal(ok.body.missing, undefined);
    assert.equal((await stored(name)).phone_number, '077-913-333');
  });
});
