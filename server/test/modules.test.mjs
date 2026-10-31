// Back-office modules (SPEC.md §2): the role → right matrix, the two new roles, and that they leave the newsroom alone.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { modulesOf, requireModule, rightOf } from '../access.mjs';
import { query } from '../db.mjs';
import { readableBy } from '../news.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { anon, login } from './helpers.mjs';

const at = (role, email = 'x@sru.ac.th') => ({ role, email });
const MODULES = ['calendar', 'requests', 'documents', 'equipment', 'phonebook', 'students', 'dashboard'];
const TEST_EMAILS = ['secretary-test@sru.ac.th', 'executive-test@sru.ac.th'];
const CONTACT_EMAIL = 'contact-secretary-test@sru.ac.th';
// A route guard run by hand: the status it refuses with, or 200 when it lets the request through
const guard = (mw, user) => {
  try { let passed = false; mw({ user }, {}, () => { passed = true; }); return passed ? 200 : 0; } catch (err) { return err.status; }
};

let snap, admin;
before(async () => {
  snap = await snapshot();
  admin = await login('admin');
});
after(async () => {
  await query('delete from pr_team where email = any($1)', [TEST_EMAILS]);
  await query('delete from users where email = $1', [CONTACT_EMAIL]);
  await restore(snap);
});

describe('module rights (SPEC §2)', () => {
  test('each role gets its modules and no others', () => {
    assert.deepEqual(modulesOf(at('admin')), MODULES);
    assert.deepEqual(modulesOf(at('pr')), MODULES);
    assert.deepEqual(modulesOf(at('student', 'x@student.sru.ac.th')), ['calendar', 'equipment', 'phonebook', 'students']);
    assert.deepEqual(modulesOf(at('secretary')), ['calendar', 'requests', 'phonebook']);
    assert.deepEqual(modulesOf(at('executive')), ['calendar', 'requests', 'phonebook', 'students', 'dashboard']);
    assert.deepEqual(modulesOf(at('staff')), ['phonebook']);
  });
  test('the right in a module, not only the module', () => {
    assert.equal(rightOf(at('pr'), 'calendar'), 'edit');
    assert.equal(rightOf(at('secretary'), 'calendar'), 'create');
    assert.equal(rightOf(at('executive'), 'calendar'), 'view');
    assert.equal(rightOf(at('student', 'x@student.sru.ac.th'), 'equipment'), 'request');
    assert.equal(rightOf(at('executive'), 'students'), 'summary');
  });
  test('coordinators and interns count as their domain role', () => {
    assert.deepEqual(modulesOf(at('coordinator')), modulesOf(at('staff')));
    assert.deepEqual(modulesOf(at('intern', 'x@student.sru.ac.th')), modulesOf(at('student', 'x@student.sru.ac.th')));
    assert.deepEqual(modulesOf(at('intern')), modulesOf(at('staff')));
  });
  test('external is always denied, whatever role it was given; PR and admin keep theirs', () => {
    for (const role of ['external', 'secretary', 'executive', 'coordinator', 'intern']) assert.deepEqual(modulesOf(at(role, 'x@gmail.com')), [], role);
    assert.deepEqual(modulesOf(at('pr', 'x@gmail.com')), MODULES);
    assert.deepEqual(modulesOf(null), []);
    assert.equal(rightOf(at('admin'), 'no-such-module'), null);
  });
  test('requireModule: 401 signed out, 403 without the right, through with it', () => {
    assert.equal(guard(requireModule('documents'), null), 401);
    assert.equal(guard(requireModule('documents'), at('external', 'x@gmail.com')), 403);
    assert.equal(guard(requireModule('documents'), at('staff')), 403);
    assert.equal(guard(requireModule('documents'), at('pr')), 200);
    assert.equal(guard(requireModule('calendar', 'all', 'edit'), at('pr')), 200);
    assert.equal(guard(requireModule('calendar', 'all', 'edit'), at('executive')), 403);
  });
});

describe('secretary and executive roles', () => {
  test('admin gives and takes back the roles', async () => {
    for (const [email, role] of [[TEST_EMAILS[0], 'secretary'], [TEST_EMAILS[1], 'executive']]) {
      assert.equal((await admin.call('PUT', '/api/admin/roles', { email, role })).status, 200);
      const list = await admin.call('GET', `/api/admin/users?role=${role}`);
      assert.ok(list.body.items.some((u) => u.email === email), `${role} filter`);
    }
    assert.equal((await admin.call('PUT', '/api/admin/roles', { email: TEST_EMAILS[0], role: 'default' })).status, 200);
    assert.equal((await query('select 1 from pr_team where email = $1', [TEST_EMAILS[0]])).rowCount, 0);
  });
  test('/api/me: the modules, and the role that counts in the newsroom', async () => {
    const secretary = await login('secretary');
    const me = (await secretary.call('GET', '/api/me')).body;
    assert.equal(me.user.role, 'secretary');
    assert.equal(me.user.baseRole, 'staff');
    assert.deepEqual(me.modules, ['calendar', 'requests', 'phonebook']);
    assert.deepEqual((await (await login('external')).call('GET', '/api/me')).body.modules, []);
    assert.deepEqual((await anon.call('GET', '/api/me')).body.modules, undefined);
  });
  test('in the newsroom they are staff: same stories, same profile rules, no PR desk', async () => {
    for (const as of ['secretary', 'executive']) {
      assert.deepEqual(readableBy(at(as)), readableBy(at('staff')), as);
      const who = await login(as);
      const profile = await who.call('PUT', '/api/me/profile', { firstName: 'ทดสอบ', lastName: 'ระบบ', phone: '0812345678', consent: true });
      assert.equal(profile.status, 400, `${as}: staff give a 4-digit extension`);
      assert.ok(profile.body.fields?.phone || profile.body.details?.phone, `${as}: the phone field is the one refused`);
      assert.equal((await who.call('GET', '/api/pr/queue')).status, 403, `${as}: PR desk`);
      assert.equal((await who.call('GET', '/api/admin/users')).status, 403, `${as}: admin`);
    }
  });
  test('ติดต่อเรา: a faculty PR person given one of the roles stays on the page', async () => {
    await query(`insert into users (email, name, role, unit, position, first_name, last_name, phone, consent_at)
      values ($1, 'เลขาคณะ ทดสอบ', 'secretary', 'คณะครุศาสตร์', 'นักประชาสัมพันธ์', 'เลขาคณะ', 'ทดสอบ', '2299', now())`, [CONTACT_EMAIL]);
    const people = (await anon.call('GET', '/api/contact')).body.faculties.flatMap((f) => f.people);
    assert.ok(people.some((p) => p.name === 'เลขาคณะ ทดสอบ'));
  });
});
