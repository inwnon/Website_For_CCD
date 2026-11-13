// คำขอใช้บริการ (SPEC.md §2, §4, §8): who sees and decides what, the event an approval makes, notifications and PDPA.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { one, query, tx } from '../db.mjs';
import { erase } from '../privacy.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { anon, login } from './helpers.mjs';

const HOUR = 60 * 60 * 1000;
const later = (hours) => new Date(Date.now() + hours * HOUR).toISOString();
const TEMP_EMAIL = 'requests-test@sru.ac.th';
const UUID = '00000000-0000-4000-8000-000000000000';
const body = (over = {}) => ({ title: 'งานทดสอบคำขอ', type: 'photo', location: 'หอประชุมทดสอบ', startAt: later(24 * 5), endAt: later(24 * 5 + 2), details: 'รายละเอียดทดสอบ', ...over });

let snap, pr, admin, student, secretary, executive, staff, external, ids;
const idOf = async (who) => (await who.call('GET', '/api/me')).body.user.id;
const notes = async (who, ref) => (await who.call('GET', '/api/notifications')).body.items.filter((n) => n.refId === ref);
const submit = async (over) => {
  const r = await secretary.call('POST', '/api/requests', body(over));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.request;
};

before(async () => {
  snap = await snapshot();
  [pr, admin, student, secretary, executive, staff, external] = await Promise.all(['pr', 'admin', 'student', 'secretary', 'executive', 'staff', 'external'].map(login));
  ids = { student: await idOf(student), secretary: await idOf(secretary) };
});
after(async () => {
  await query('delete from users where email = $1', [TEMP_EMAIL]);
  await restore(snap);
});

describe('submitting', () => {
  test('a secretary submits: pending, PR is told in-app and by email, audit_log has it', async () => {
    const r = await submit();
    assert.equal(r.status, 'pending');
    assert.equal(r.eventId, null);
    assert.equal((await notes(pr, r.id))[0].kind, 'request.new');
    assert.ok((await one(`select count(*)::int n from email_outbox where kind = 'request.new' and ref = $1`, [r.id])).n >= 1);
    assert.equal((await one(`select count(*)::int n from audit_log where action = 'request.create' and target = $1`, [r.id])).n, 1);
  });
  test('bad input is refused, field by field', async () => {
    for (const over of [{ title: ' ' }, { type: 'catering' }, { location: '' }, { startAt: 'พรุ่งนี้' }, { startAt: later(-1) }, { endAt: later(24) }]) {
      const field = Object.keys(over)[0];
      const r = await secretary.call('POST', '/api/requests', body(over));
      assert.equal(r.status, 400, field);
      assert.ok(r.body.details?.[field], field);
    }
    assert.equal((await secretary.call('POST', '/api/requests', body({ details: 'ก'.repeat(2001) }))).status, 400);
  });
  test('the requester cancels while pending, and only their own', async () => {
    const r = await submit();
    assert.equal((await pr.call('POST', `/api/requests/${r.id}/cancel`, {})).status, 403);
    const done = await secretary.call('POST', `/api/requests/${r.id}/cancel`, {});
    assert.equal(done.body.request.status, 'cancelled');
    assert.equal((await secretary.call('POST', `/api/requests/${r.id}/cancel`, {})).status, 409);
    assert.equal((await pr.call('POST', `/api/requests/${r.id}/approve`, { assignees: [] })).status, 409);
    assert.equal((await one(`select count(*)::int n from audit_log where action = 'request.cancel' and target = $1`, [r.id])).n, 1);
  });
  test('a new request reaches PR and admin through /api/pr/arrivals (the urgent alert), no one else', async () => {
    for (const who of [secretary, executive, staff, student, external]) assert.equal((await who.call('GET', '/api/pr/arrivals')).status, 403);
    const first = (await pr.call('GET', '/api/pr/arrivals')).body;
    assert.deepEqual(first.requests, [], 'the first answer only sets the time to ask from');
    const r = await submit({ title: 'ขอช่างภาพด่วน' });
    for (const who of [pr, admin]) {
      const next = (await who.call('GET', `/api/pr/arrivals?since=${encodeURIComponent(first.now)}`)).body;
      const hit = next.requests.find((x) => x.id === r.id);
      assert.ok(hit, 'the new request is in the alert');
      assert.equal(hit.title, 'ขอช่างภาพด่วน');
      assert.equal(hit.location, 'หอประชุมทดสอบ');
      assert.ok(hit.requester);
    }
    await secretary.call('POST', `/api/requests/${r.id}/cancel`, {});
    const gone = (await pr.call('GET', `/api/pr/arrivals?since=${encodeURIComponent(first.now)}`)).body;
    assert.ok(!gone.requests.some((x) => x.id === r.id), 'a cancelled request is not shown');
  });
});

describe('deciding', () => {
  test('approval makes one internal event with the assignees; the requester is told; a second approval is refused', async () => {
    const r = await submit();
    const assignees = [{ userId: ids.student, duty: 'ช่างภาพ' }];
    const done = await pr.call('POST', `/api/requests/${r.id}/approve`, { assignees, note: 'จัดช่างภาพให้แล้ว' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.request.status, 'approved');
    assert.equal(done.body.request.reviewNote, 'จัดช่างภาพให้แล้ว');
    const e = (await pr.call('GET', `/api/calendar/events/${done.body.request.eventId}`)).body.event;
    assert.equal(e.title, r.title);
    assert.equal(e.type, 'media');
    assert.equal(e.visibility, 'internal');
    assert.equal(e.description, r.details);
    assert.equal(e.startAt, r.startAt);
    assert.deepEqual(e.assignees.map((a) => a.duty), ['ช่างภาพ']);
    assert.equal(e.canEdit, true);
    assert.equal((await secretary.call('GET', `/api/calendar/events/${e.id}`)).body.event.canEdit, false, 'the event belongs to the PR team');
    assert.equal((await notes(student, e.id))[0].kind, 'event.assigned');
    assert.equal((await notes(secretary, r.id))[0].kind, 'request.approved');
    assert.equal((await one(`select count(*)::int n from email_outbox where kind = 'request.approved' and ref = $1`, [r.id])).n, 1);
    assert.equal((await one(`select count(*)::int n from audit_log where action = 'request.approve' and target = $1`, [r.id])).n, 1);
    assert.equal((await pr.call('POST', `/api/requests/${r.id}/approve`, { assignees: [] })).status, 409);
  });
  test('assignees can wait for the calendar, and a bad list leaves the request pending with no event', async () => {
    const r = await submit();
    const bad = await pr.call('POST', `/api/requests/${r.id}/approve`, { assignees: [{ userId: ids.secretary, duty: 'ช่างภาพ' }] });
    assert.equal(bad.status, 400);
    const still = (await secretary.call('GET', `/api/requests/${r.id}`)).body.request;
    assert.equal(still.status, 'pending');
    assert.equal(still.eventId, null);
    const done = await admin.call('POST', `/api/requests/${r.id}/approve`, {});
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.ok(done.body.request.eventId);
  });
  test('two approvals at once make one event', async () => {
    const r = await submit();
    const both = await Promise.all([1, 2].map(() => pr.call('POST', `/api/requests/${r.id}/approve`, {})));
    assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
    assert.equal((await one('select count(*)::int n from audit_log where action = $1 and target = $2', ['request.approve', r.id])).n, 1);
  });
  test('rejection needs a reason, which the requester sees; no event is made', async () => {
    const r = await submit();
    assert.equal((await pr.call('POST', `/api/requests/${r.id}/reject`, {})).status, 400);
    const done = await pr.call('POST', `/api/requests/${r.id}/reject`, { note: 'วันนั้นทีมไม่ว่าง' });
    assert.equal(done.body.request.status, 'rejected');
    assert.equal(done.body.request.eventId, null);
    const seen = (await secretary.call('GET', `/api/requests/${r.id}`)).body.request;
    assert.equal(seen.reviewNote, 'วันนั้นทีมไม่ว่าง');
    assert.equal((await notes(secretary, r.id))[0].kind, 'request.rejected');
    assert.equal((await pr.call('POST', `/api/requests/${r.id}/reject`, { note: 'ซ้ำ' })).status, 409);
    assert.equal((await one(`select count(*)::int n from audit_log where action = 'request.reject' and target = $1`, [r.id])).n, 1);
  });
});

describe('who may do what', () => {
  test('student, staff, external and the signed-out have no access to any route', async () => {
    const r = await submit();
    const calls = [['GET', '/api/requests'], ['GET', `/api/requests/${r.id}`], ['POST', '/api/requests'], ['POST', `/api/requests/${r.id}/cancel`], ['POST', `/api/requests/${r.id}/approve`], ['POST', `/api/requests/${r.id}/reject`]];
    for (const [method, path] of calls) {
      const payload = method === 'POST' ? body({ note: 'x' }) : undefined;
      for (const who of [student, staff, external]) assert.equal((await who.call(method, path, payload)).status, 403, path);
      assert.equal((await anon.call(method, path, payload)).status, 401, path);
    }
  });
  test('only PR and admin decide; PR does not submit; an executive only reads', async () => {
    const r = await submit();
    for (const who of [secretary, executive]) {
      assert.equal((await who.call('POST', `/api/requests/${r.id}/approve`, {})).status, 403);
      assert.equal((await who.call('POST', `/api/requests/${r.id}/reject`, { note: 'x' })).status, 403);
    }
    assert.equal((await pr.call('POST', '/api/requests', body())).status, 403);
    assert.equal((await executive.call('POST', '/api/requests', body())).status, 403);
    assert.equal((await executive.call('GET', `/api/requests/${r.id}`)).status, 200);
    assert.ok((await executive.call('GET', '/api/requests')).body.items.some((x) => x.id === r.id));
  });
  test('a secretary sees only their own requests; other ids answer 403', async () => {
    const mine = await submit();
    const other = await one(`insert into service_requests (requester_id, title, type, start_at, end_at, location) values ($1, 'ของคนอื่น', 'photo', $2, $3, 'ที่อื่น') returning id`,
      [ids.student, later(24), later(25)]);
    try {
      const list = (await secretary.call('GET', '/api/requests')).body.items;
      assert.ok(list.some((x) => x.id === mine.id));
      assert.ok(!list.some((x) => x.id === other.id));
      assert.equal((await secretary.call('GET', `/api/requests/${other.id}`)).status, 403);
      assert.equal((await secretary.call('POST', `/api/requests/${other.id}/cancel`, {})).status, 403);
      assert.ok((await pr.call('GET', '/api/requests')).body.items.some((x) => x.id === other.id));
    } finally {
      await query('delete from service_requests where id = $1', [other.id]);
    }
  });
  test('the list filters by status; unknown ids and filters are refused', async () => {
    const r = await submit();
    const pending = (await pr.call('GET', '/api/requests?status=pending')).body.items;
    assert.ok(pending.some((x) => x.id === r.id));
    assert.ok(pending.every((x) => x.status === 'pending'));
    assert.ok(!(await pr.call('GET', '/api/requests?status=approved')).body.items.some((x) => x.id === r.id));
    assert.equal((await pr.call('GET', '/api/requests?status=nope')).status, 400);
    assert.equal((await pr.call('GET', `/api/requests/${UUID}`)).status, 404);
    assert.equal((await pr.call('GET', '/api/requests/not-an-id')).status, 404);
    assert.equal((await pr.call('POST', `/api/requests/${UUID}/approve`, {})).status, 404);
  });
});

describe('requests.html', () => {
  test('the page opens but stays out of search results', async () => {
    const r = await anon.call('GET', '/requests.html');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('x-robots-tag') || '', /noindex/);
  });
});

describe('PDPA', () => {
  test('the export lists the requester\'s requests; erasing unlinks them and cancels what is pending', async () => {
    const r = await submit();
    const data = (await secretary.call('GET', '/api/me/data')).body;
    assert.ok(data.serviceRequests.some((x) => x.title === r.title));

    const u = await one(`insert into users (email, name, role) values ($1, 'ผู้ขอทดสอบ', 'staff') returning id`, [TEMP_EMAIL]);
    const row = await one(`insert into service_requests (requester_id, title, type, start_at, end_at, location) values ($1, 'ของผู้ขอ', 'photo', $2, $3, 'ที่ใด') returning id`, [u.id, later(24), later(25)]);
    try {
      await tx((c) => erase(c, u.id));
      const gone = await one('select requester_id, status from service_requests where id = $1', [row.id]);
      assert.equal(gone.requester_id, null);
      assert.equal(gone.status, 'cancelled');
    } finally {
      await query('delete from service_requests where id = $1', [row.id]);
    }
  });
});

describe('staff asking for access', () => {
  const STAFF = 'user@sru.ac.th';
  const mine = async () => (await staff.call('GET', '/api/request-access')).body;
  before(async () => { await query('delete from request_access where email = $1', [STAFF]); });

  test('only plain university staff may ask; secretary, student and external get 403', async () => {
    assert.equal((await anon.call('POST', '/api/request-access', {})).status, 401);
    for (const who of [student, external, secretary, pr]) assert.equal((await who.call('POST', '/api/request-access', { reason: 'x' })).status, 403);
    assert.equal((await mine()).canAsk, true);
    assert.equal((await external.call('GET', '/api/request-access')).body.canAsk, false);
  });

  test('the menus offer the page to staff who may ask (askable), and to nobody else', async () => {
    assert.deepEqual((await staff.call('GET', '/api/me')).body.askable, ['requests']);
    for (const who of [student, external, secretary, executive, pr, admin]) assert.deepEqual((await who.call('GET', '/api/me')).body.askable, []);
    assert.equal((await anon.call('GET', '/api/me')).body.askable, undefined);
  });

  test('ask → PR is told → reject with a reason → ask again → PR approves → staff submits only their own → admin revokes', async () => {
    assert.equal((await staff.call('POST', '/api/requests', body())).status, 403);
    // audit_log keeps the rows of earlier runs for the same account: count only this run's
    const { started } = await one('select now() started');
    const asked = await staff.call('POST', '/api/request-access', { reason: 'ขอช่างภาพงานคณะ' });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    const id = asked.body.access.id;
    assert.equal((await staff.call('POST', '/api/request-access', {})).status, 409);
    assert.equal((await notes(pr, String(id)))[0].kind, 'access.new');
    assert.equal((await one(`select count(*)::int n from audit_log where action = 'access.ask' and target = $1 and at >= $2`, [STAFF, started])).n, 1);
    assert.ok((await pr.call('GET', '/api/request-access/list?status=pending')).body.items.some((a) => a.id === id));
    for (const who of [staff, secretary, executive]) assert.equal((await who.call('GET', '/api/request-access/list')).status, 403);

    assert.equal((await pr.call('POST', `/api/request-access/${id}/reject`, { note: ' ' })).status, 400);
    assert.equal((await pr.call('POST', `/api/request-access/${id}/reject`, { note: 'ใช้ผ่านเลขาคณะ' })).body.access.status, 'rejected');
    assert.equal((await mine()).access.reviewNote, 'ใช้ผ่านเลขาคณะ');
    assert.equal((await staff.call('POST', '/api/requests', body())).status, 403);

    assert.equal((await staff.call('POST', '/api/request-access', { reason: 'ขออีกครั้ง' })).status, 201);
    assert.equal((await executive.call('POST', `/api/request-access/${id}/approve`, {})).status, 403);
    assert.equal((await pr.call('POST', `/api/request-access/${id}/approve`, {})).body.access.status, 'approved');
    assert.equal((await pr.call('POST', `/api/request-access/${id}/approve`, {})).status, 409);
    assert.equal((await notes(staff, String(id)))[0].kind, 'access.approved');
    assert.ok((await staff.call('GET', '/api/me')).body.modules.includes('requests'));
    assert.ok(!(await staff.call('GET', '/api/me')).body.modules.includes('calendar'));
    assert.deepEqual((await staff.call('GET', '/api/me')).body.askable, []);

    const made = await staff.call('POST', '/api/requests', body());
    assert.equal(made.status, 201);
    const other = await submit();
    const list = (await staff.call('GET', '/api/requests')).body.items;
    assert.ok(list.some((r) => r.id === made.body.request.id) && !list.some((r) => r.id === other.id));
    assert.equal((await staff.call('GET', `/api/requests/${other.id}`)).status, 403);
    assert.equal((await staff.call('POST', `/api/requests/${made.body.request.id}/approve`, { assignees: [] })).status, 403);

    assert.equal((await pr.call('POST', `/api/request-access/${id}/revoke`, {})).status, 403);
    assert.equal((await admin.call('POST', `/api/request-access/${id}/revoke`, {})).status, 204);
    assert.equal((await staff.call('GET', '/api/requests')).status, 403);
    assert.equal((await mine()).canAsk, true);
    for (const action of ['access.approve', 'access.reject', 'access.revoke']) {
      assert.equal((await one('select count(*)::int n from audit_log where action = $1 and target = $2 and at >= $3', [action, STAFF, started])).n, 1, action);
    }
  });

  test('a bad id is 404', async () => {
    assert.equal((await pr.call('POST', '/api/request-access/abc/approve', {})).status, 404);
    assert.equal((await pr.call('POST', '/api/request-access/999999999/reject', { note: 'x' })).status, 404);
  });
});
