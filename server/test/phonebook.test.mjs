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

let snap, pr, admin, student, secretary, executive, staff, coordinator, external, intern;
const EDITORS = ['pr@sru.ac.th', 'intern@student.sru.ac.th'];
// A day in Thai time, n days from today, as YYYY-MM-DD
const thaiDay = (n) => new Date(Date.now() + 7 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
/** @param {string} email @param {any} [until] anything, to test what the server refuses */
const lend = (email, until = thaiDay(1)) => admin.call('POST', '/api/admin/phonebook-editors', { email, until });
const create = async (over) => {
  const r = await pr.call('POST', '/api/phonebook', entry(over));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.entry;
};
const logged = async (action, id) => (await one('select count(*)::int n from audit_log where action = $1 and target = $2', [action, id])).n;
const find = async (who, q) => (await who.call('GET', `/api/phonebook?q=${encodeURIComponent(q)}`)).body.matches;
const counts = ({ added, updated, unchanged, removed, saved }) => ({ added, updated, unchanged, removed, saved });
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
  [pr, admin, student, secretary, executive, staff, coordinator, external, intern] = await Promise.all(['pr', 'admin', 'student', 'secretary', 'executive', 'staff', 'coordinator', 'external', 'intern'].map(login));
  assert.equal((await lend(EDITORS[0])).status, 201, 'PR edits in these tests on a loan from admin');
});
after(async () => {
  await query('delete from phonebook where unit_name like $1', [`${UNIT}%`]);
  await query('delete from phonebook_editors where email = any($1)', [EDITORS]);
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
  test('a unit may have either number alone; only a หน่วยงานหลัก may have neither', async () => {
    assert.equal((await create({ internalNumber: null })).internalNumber, null);
    assert.equal((await create({ phoneNumber: null })).phoneNumber, null);
    const heading = await create({ phoneNumber: ' ', internalNumber: '' });
    assert.deepEqual([heading.phoneNumber, heading.internalNumber], [null, null]);
    const r = await pr.call('POST', '/api/phonebook', entry({ phoneNumber: ' ', internalNumber: '', parentId: heading.id }));
    assert.equal(r.status, 400);
    assert.ok(r.body.details.phoneNumber);
    assert.equal((await create({ internalNumber: '6010/3400', parentId: heading.id })).internalNumber, '6010/3400');
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
    assert.deepEqual(counts(preview.body), { added: 2, updated: 1, unchanged: 1, removed: 0, saved: false });
    assert.equal(await stored(a), null, 'nothing saved yet');

    const saved = await send(pr, buf, 'phones.xlsx', true);
    assert.deepEqual(counts(saved.body), { added: 2, updated: 1, unchanged: 1, removed: 0, saved: true });
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
    assert.deepEqual(r.body.details.problems.map((p) => p.match(/^แถว (\d+)/)[1]), ['3', '4', '7'], 'a name with no number is a หน่วยงานหลัก');
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
  test('two numbers in one cell stay as typed, by hand and from a file', async () => {
    for (const typed of ['077-913-333/4', '077913333, 077913334']) {
      assert.equal((await create({ phoneNumber: typed })).phoneNumber, typed, typed);
    }
    const name = unit();
    const r = await send(pr, await sheet([[name, '077-913-333/4']], ['หน่วยงาน', 'เบอร์โทรศัพท์']), 'phones.xlsx', true);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await stored(name)).phone_number, '077-913-333/4');
  });
});

describe('moving units into a group', () => {
  const move = (ids, parentId, who = pr) => who.call('POST', '/api/phonebook/move', { ids, parentId });
  const parentOf = async (id) => (await one('select parent_id from phonebook where id = $1', [id])).parent_id;
  test('a new group is a name alone; several units move in at once and back out, each in audit_log', async () => {
    const group = await create({ unitName: unit('กลุ่ม'), phoneNumber: null, internalNumber: null, note: null });
    const [a, b] = [await create(), await create()];
    const r = await move([a.id, b.id], group.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.moved, 2);
    assert.deepEqual([await parentOf(a.id), await parentOf(b.id)], [group.id, group.id]);
    assert.deepEqual([await logged('phonebook.move', a.id), await logged('phonebook.move', b.id)], [1, 1]);
    assert.equal((await move([a.id, b.id], group.id)).body.moved, 0, 'already there: nothing to move or log');
    assert.equal(await logged('phonebook.move', a.id), 1);
    assert.equal((await move([a.id], null)).body.moved, 1);
    assert.equal(await parentOf(a.id), null);
  });
  test('only those who may edit move units, even with the ids', async () => {
    const [group, a] = [await create(), await create()];
    for (const who of [student, staff, secretary, executive, external]) assert.equal((await move([a.id], group.id, who)).status, 403);
    assert.equal((await move([a.id], group.id, anon)).status, 401);
    assert.equal(await parentOf(a.id), null);
  });
  test('one unit that cannot move stops them all', async () => {
    const group = await create();
    const [a, heading] = [await create(), await create({ phoneNumber: null, internalNumber: null })];
    let r = await move([a.id, heading.id], group.id);
    assert.equal(r.status, 400);
    assert.ok(r.body.error.includes(heading.unitName), 'names the unit with no number');
    assert.equal(await parentOf(a.id), null);

    const sub = await create({ parentId: a.id });
    r = await move([a.id], sub.id);
    assert.equal(r.status, 400, 'not under its own sub-unit');
    assert.equal((await move([group.id], group.id)).status, 400, 'not under itself');

    const taken = await create({ parentId: group.id });
    const same = await create({ unitName: taken.unitName });
    r = await move([a.id, same.id], group.id);
    assert.equal(r.status, 400, 'a name used once under the same group');
    assert.equal(await parentOf(a.id), null);
  });
  test('unknown ids are 404; bad input is 400', async () => {
    const a = await create();
    assert.equal((await move([a.id, '00000000-0000-4000-8000-000000000000'], null)).status, 404);
    assert.equal((await move([a.id], '00000000-0000-4000-8000-000000000000')).status, 400);
    for (const ids of [[], 'x', ['nope'], [a.id, a.id], null]) assert.equal((await move(ids, null)).status, 400, JSON.stringify(ids));
    assert.equal((await move([a.id], 'nope')).status, 400);
  });
});

describe('importing units under a หน่วยงานหลัก', () => {
  const GROUPED = ['หน่วยงานหลัก', ...HEAD];
  test('a new หน่วยงานหลัก and its units come in together; a unit imported before moves under it', async () => {
    const [top, sub, loose] = [unit('คณะ'), unit('สำนักงานคณบดี'), unit('สาขา')];
    const before = await create({ unitName: loose, phoneNumber: '077913000' });
    const buf = await sheet([['', top, '077913100', '', ''], [top, sub, '077913101', '', ''], [top, loose, '', '3102', '']], GROUPED);
    const preview = await send(pr, buf);
    assert.deepEqual(counts(preview.body), { added: 2, updated: 1, unchanged: 0, removed: 0, saved: false });
    assert.equal((await send(pr, buf, 'phones.xlsx', true)).status, 200);
    const parent = await stored(top);
    assert.equal(parent.parent_id, null);
    assert.equal((await stored(sub)).parent_id, parent.id);
    const moved = await one('select * from phonebook where id = $1', [before.id]);
    assert.deepEqual([moved.parent_id, moved.phone_number, moved.internal_number], [parent.id, '077-913-000', '3102']);
  });
  test('a unit imported before moves under one หน่วยงานหลัก only; the file names it under another too', async () => {
    const [a, b, loose] = [unit('คณะ'), unit('คณะ'), unit('สำนักงานคณบดี')];
    const before = await create({ unitName: loose, phoneNumber: '077913000' });
    const buf = await sheet([['', a, '', '', ''], ['', b, '', '', ''], [a, loose, '077913201', '', ''], [b, loose, '077913202', '', '']], GROUPED);
    assert.deepEqual(counts((await send(pr, buf)).body), { added: 3, updated: 1, unchanged: 0, removed: 0, saved: false });
    assert.equal((await send(pr, buf, 'phones.xlsx', true)).status, 200);
    const [pa, pb] = [await stored(a), await stored(b)];
    const units = (await query('select id, parent_id, phone_number from phonebook where unit_name = $1', [loose])).rows;
    assert.deepEqual(units.map((u) => u.parent_id).sort(), [pa.id, pb.id].sort());
    assert.equal(units.find((u) => u.id === before.id).parent_id, pa.id);
  });
  test('a unit the file also uses as a หน่วยงานหลัก stays one; the file gets its own unit of that name', async () => {
    const [top, loose, sub] = [unit('คณะ'), unit('สำนัก'), unit('งาน')];
    const before = await create({ unitName: loose, phoneNumber: '077913000' });
    const buf = await sheet([['', top, '', '', ''], [top, loose, '077913301', '', ''], [loose, sub, '077913302', '', '']], GROUPED);
    assert.equal((await send(pr, buf, 'phones.xlsx', true)).status, 200);
    assert.equal((await one('select parent_id from phonebook where id = $1', [before.id])).parent_id, null);
    assert.equal((await stored(sub)).parent_id, before.id);
    assert.ok(await one('select 1 from phonebook where unit_name = $1 and parent_id = $2', [loose, (await stored(top)).id]));
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

describe('edit rights an admin lends', () => {
  const add = (who) => who.call('POST', '/api/phonebook', entry());
  test('PR edits only while a loan runs; revoking or an ended loan takes it back', async () => {
    assert.equal((await pr.call('GET', '/api/phonebook')).body.canEdit, true);
    assert.equal((await admin.call('DELETE', `/api/admin/phonebook-editors/${EDITORS[0]}`)).status, 200);
    const without = await pr.call('GET', '/api/phonebook');
    assert.deepEqual([without.status, without.body.canEdit, without.body.editUntil], [200, false, null]);
    assert.equal((await add(pr)).status, 403);
    assert.equal((await pr.call('GET', '/api/phonebook/template.xlsx')).status, 403);

    assert.equal((await lend(EDITORS[0])).status, 201);
    const back = await pr.call('GET', '/api/phonebook');
    assert.equal(back.body.canEdit, true);
    assert.ok(new Date(back.body.editUntil) > new Date());
    assert.equal((await add(pr)).status, 201);

    await query("update phonebook_editors set expires_at = now() - interval '1 second' where email = $1", [EDITORS[0]]);
    assert.equal((await add(pr)).status, 403);
    assert.equal((await lend(EDITORS[0])).status, 201);
  });
  test('an intern may get a loan; nobody else but PR', async () => {
    assert.equal((await add(intern)).status, 403);
    assert.equal((await lend(EDITORS[1])).status, 201);
    assert.equal((await add(intern)).status, 201);
    for (const email of ['user@sru.ac.th', 'coord@sru.ac.th', 'secretary@sru.ac.th', 'admin@sru.ac.th', 'nobody@sru.ac.th']) {
      const r = await lend(email);
      assert.equal(r.status, 400, email);
      assert.ok(r.body.details.email);
    }
    const list = (await admin.call('GET', '/api/admin/phonebook-editors')).body;
    assert.deepEqual(EDITORS.map((e) => list.items.some((x) => x.email === e)), [true, true]);
    assert.ok(list.people.every((p) => ['pr', 'intern'].includes(p.role)));
  });
  test('only admin lends or takes back, and every change is logged', async () => {
    for (const who of [pr, intern, staff, secretary, executive, coordinator, external]) {
      assert.equal((await who.call('GET', '/api/admin/phonebook-editors')).status, 403);
      assert.equal((await who.call('POST', '/api/admin/phonebook-editors', { email: EDITORS[1], until: thaiDay(5) })).status, 403);
      assert.equal((await who.call('DELETE', `/api/admin/phonebook-editors/${EDITORS[1]}`)).status, 403);
    }
    assert.equal((await anon.call('GET', '/api/admin/phonebook-editors')).status, 401);
    await lend(EDITORS[1], thaiDay(3));
    await admin.call('DELETE', `/api/admin/phonebook-editors/${EDITORS[1]}`);
    assert.equal(await logged('phonebook.grant', EDITORS[1]) >= 1, true);
    assert.equal(await logged('phonebook.revoke', EDITORS[1]), 1);
    assert.equal((await admin.call('DELETE', `/api/admin/phonebook-editors/${EDITORS[1]}`)).status, 404);
  });
  test('the last day is today or later, and a real date', async () => {
    assert.equal((await lend(EDITORS[1], thaiDay(0))).status, 201, 'today is fine');
    for (const until of [thaiDay(-1), '2026-02-30', 'tomorrow', '', null, 20261231]) {
      const r = await lend(EDITORS[1], until);
      assert.equal(r.status, 400, String(until));
      assert.ok(r.body.details.until);
    }
  });
});

describe('importing the layout the PR team writes', () => {
  // A title, then per group: a heading merged across the table, the header again, and the group's units
  const grouped = async (g1, g2, names) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('สมุด');
    const heading = (text) => { const r = ws.addRow([text]); ws.mergeCells(`A${r.number}:D${r.number}`); };
    const head = ['ที่', 'หน่วยงาน', 'หมายเลขโทรศัพท์สายตรง', 'เบอร์ภายใน'];
    heading('สมุดโทรศัพท์ มหาวิทยาลัยราชภัฏสุราษฎร์ธานี');
    heading(g1);
    ws.addRow(head);
    ws.addRow([0, names[0], '077-913-333', '6900']);
    ws.addRow([1, names[1], '077-913-399', 9999]);
    heading(g2);
    ws.addRow(head);
    ws.addRow([1, g2, '', '3400']);
    ws.addRow([2, names[2], 77913320, '6010/3400']);
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  test('groups become หน่วยงานหลัก, the header may repeat, numbers and order are kept', async () => {
    const [g1, g2] = [unit('ผู้บริหาร'), unit('สำนักงานอธิการบดี')];
    const names = [unit('เบอร์สายตรง'), unit('อธิการบดี'), unit('งานธุรการ')];
    const buf = await grouped(g1, g2, names);
    const preview = await send(pr, buf);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(counts(preview.body), { added: 6, updated: 0, unchanged: 0, removed: 0, saved: false });
    assert.deepEqual(preview.body.columns, [{ header: 'ที่', field: null }, { header: 'หน่วยงาน', field: 'หน่วยงาน' },
      { header: 'หมายเลขโทรศัพท์สายตรง', field: 'เบอร์โทรศัพท์' }, { header: 'เบอร์ภายใน', field: 'เบอร์ภายใน' }]);
    assert.equal(preview.body.missing, undefined);
    assert.equal((await send(pr, buf, 'phones.xlsx', true)).status, 200);

    const [p1, p2] = [await stored(g1), await stored(g2)];
    assert.deepEqual([p1.parent_id, p1.phone_number, p1.internal_number], [null, null, null], 'a heading has no number');
    assert.deepEqual([(await stored(names[0])).parent_id, (await stored(names[0])).phone_number], [p1.id, '077-913-333']);
    assert.equal((await stored(names[1])).internal_number, '9999');
    const c = await stored(names[2]);
    assert.deepEqual([c.parent_id, c.phone_number, c.internal_number], [p2.id, '077-913-320', '6010/3400']);
    assert.equal((await one('select internal_number from phonebook where parent_id = $1 and unit_name = $2', [p2.id, g2])).internal_number, '3400', 'a unit may share its group name');
    assert.equal(await one('select 1 from phonebook where unit_name like $1', ['สมุดโทรศัพท์ มหาวิทยาลัย%']), null, 'the title is not a unit');

    const order = (await staff.call('GET', '/api/phonebook')).body.items.map((x) => x.unitName);
    assert.ok(order.indexOf(g1) < order.indexOf(g2) && order.indexOf(names[1]) > order.indexOf(names[0]), 'file order, not name order');
    const again = await send(pr, buf);
    assert.deepEqual(counts(again.body), { added: 0, updated: 0, unchanged: 6, removed: 0, saved: false });
  });
  test('the same layout as CSV: a heading is one cell outside the unit column', async () => {
    const [g, a] = [unit('กลุ่ม'), unit('หน่วย')];
    const csv = `${g},,,\r\nที่,หน่วยงาน,หมายเลขโทรศัพท์สายตรง,เบอร์ภายใน\r\n1,${a},077-913-301,3301\r\n`;
    const r = await send(pr, Buffer.concat([BOM, Buffer.from(csv)]), 'phones.csv', true, 'text/csv');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await stored(a)).parent_id, (await stored(g)).id);
  });
  test('the CSV template opens in Excel with Thai headers', async () => {
    const r = await pr.call('GET', '/api/phonebook/template.csv');
    assert.equal(r.status, 200);
    assert.equal(String(r.body).replace(/^\ufeff/, '').trim(), TEMPLATE.join(','));
    assert.equal((await staff.call('GET', '/api/phonebook/template.csv')).status, 403);
  });
  test('replacing the whole book: admin only, and the book is then exactly the file', async () => {
    const [g1, g2] = [unit('ผู้บริหาร'), unit('สำนักงาน')];
    const buf = await grouped(g1, g2, [unit(), unit(), unit()]);
    const fd = () => { const d = new FormData(); d.append('file', new Blob([buf], { type: XLSX }), 'p.xlsx'); return d; };
    assert.equal((await pr.call('POST', '/api/phonebook/import?replace=1', fd())).status, 403);
    // Saving wipes the whole book, so what was there (other tests' units, a developer's own data) comes back afterwards
    const kept = (await query('select coalesce(json_agg(p), \'[]\') rows from phonebook p')).rows[0].rows;
    try {
      const preview = await admin.call('POST', '/api/phonebook/import?replace=1', fd());
      assert.deepEqual(counts(preview.body), { added: 6, updated: 0, unchanged: 0, removed: kept.length, saved: false });
      const saved = await admin.call('POST', '/api/phonebook/import?replace=1&save=1', fd());
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal((await one('select count(*)::int n from phonebook')).n, 6);
    } finally {
      // One statement, so a sub-unit may come before its หน่วยงานหลัก
      await query('delete from phonebook');
      await query('insert into phonebook select * from json_populate_recordset(null::phonebook, $1)', [JSON.stringify(kept)]);
    }
  });
});
