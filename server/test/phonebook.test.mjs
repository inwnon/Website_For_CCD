// สมุดโทรศัพท์ (SPEC.md §2, §4): who sees and changes what, Thai search, validation and audit_log.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { one, query } from '../db.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { anon, login } from './helpers.mjs';

const UNIT = 'ทดสอบสมุดโทรศัพท์';
const entry = (over = {}) => ({ unitName: `${UNIT} กองกลาง`, phoneType: 'unit', number: '0-7791-3333', note: 'เวลาราชการ', ...over });

let snap, pr, admin, student, secretary, executive, staff, coordinator, external;
const create = async (over) => {
  const r = await pr.call('POST', '/api/phonebook', entry(over));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.entry;
};
const logged = async (action, id) => (await one('select count(*)::int n from audit_log where action = $1 and target = $2', [action, id])).n;
const find = async (who, q) => (await who.call('GET', `/api/phonebook?q=${encodeURIComponent(q)}`)).body.items;

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
      assert.equal((await who.call('PUT', `/api/phonebook/${e.id}`, entry({ number: '1111' }))).status, 403);
      assert.equal((await who.call('DELETE', `/api/phonebook/${e.id}`)).status, 403);
    }
    assert.equal((await one('select number from phonebook where id = $1', [e.id])).number, e.number);
  });
});

describe('changing entries', () => {
  test('create, update and delete, each in audit_log', async () => {
    const e = await create();
    assert.equal(e.phoneType, 'unit');
    assert.equal(await logged('phonebook.create', e.id), 1);

    const put = await pr.call('PUT', `/api/phonebook/${e.id}`, entry({ phoneType: 'internal', number: '1234', note: null }));
    assert.equal(put.status, 200);
    assert.deepEqual([put.body.entry.phoneType, put.body.entry.number, put.body.entry.note], ['internal', '1234', null]);
    assert.equal(await logged('phonebook.update', e.id), 1);

    assert.equal((await admin.call('DELETE', `/api/phonebook/${e.id}`)).status, 200);
    assert.equal(await one('select 1 from phonebook where id = $1', [e.id]), null);
    assert.equal(await logged('phonebook.delete', e.id), 1);
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
    await wrong({ phoneType: 'mobile' }, 'phoneType');
    await wrong({ number: '' }, 'number');
    await wrong({ number: 'โทรหาสมชาย' }, 'number');
    await wrong({ number: '12' }, 'number');
    assert.equal((await pr.call('POST', '/api/phonebook', 'x')).status, 400);
  });
  test('text that is too long or not text is refused', async () => {
    assert.equal((await pr.call('POST', '/api/phonebook', entry({ unitName: 'ก'.repeat(201) }))).status, 400);
    assert.equal((await pr.call('POST', '/api/phonebook', entry({ note: { a: 1 } }))).status, 400);
  });
});

describe('search', () => {
  test('finds a unit by a word inside its Thai name, by number and by note', async () => {
    const e = await create({ unitName: `${UNIT} สำนักงานอธิการบดี`, number: '0-7791-9876', note: 'ห้องประชุมใหญ่' });
    for (const q of ['อธิการบดี', 'สำนักงาน อธิการบดี', '9876', 'ประชุมใหญ่']) assert.ok((await find(staff, q)).some((x) => x.id === e.id), q);
    assert.deepEqual(await find(staff, 'ไม่มีหน่วยงานนี้แน่นอน'), []);
  });
  test('% and _ are plain characters', async () => {
    await create();
    assert.deepEqual(await find(staff, '%'), []);
    assert.deepEqual(await find(staff, '_'), []);
  });
});
