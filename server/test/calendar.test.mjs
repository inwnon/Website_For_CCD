// ปฏิทินงาน (SPEC.md §2, §4, §7): who sees and changes what, the public feed, notifications and PDPA.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { one, query, tx } from '../db.mjs';
import { eventReminders } from '../notify.mjs';
import { erase } from '../privacy.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { anon, login } from './helpers.mjs';

const HOUR = 60 * 60 * 1000;
const later = (hours) => new Date(Date.now() + hours * HOUR).toISOString();
const bkk = (hours) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(Date.now() + hours * HOUR));
const RANGE = `from=${bkk(-24)}&to=${bkk(24 * 30)}`;
const TEMP_EMAIL = 'calendar-test@student.sru.ac.th';
const NOTE = 'โน้ตภายในทดสอบ';
const event = (over = {}) => ({ title: 'งานทดสอบปฏิทิน', type: 'media', location: 'หอประชุมทดสอบ', startAt: later(24 * 5), endAt: later(24 * 5 + 2), description: 'รายละเอียดทดสอบ', internalNote: NOTE, assignees: [], ...over });

let snap, pr, admin, student, secretary, executive, staff, external, ids;
const idOf = async (who) => (await who.call('GET', '/api/me')).body.user.id;
const notes = async (who, ref) => (await who.call('GET', '/api/notifications')).body.items.filter((n) => n.refId === ref);
const create = async (over) => {
  const r = await pr.call('POST', '/api/calendar/events', event(over));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.event;
};

before(async () => {
  snap = await snapshot();
  [pr, admin, student, secretary, executive, staff, external] = await Promise.all(['pr', 'admin', 'student', 'secretary', 'executive', 'staff', 'external'].map(login));
  ids = { pr: await idOf(pr), student: await idOf(student), staff: await idOf(staff), external: await idOf(external) };
});
after(async () => {
  await query('delete from users where email = $1', [TEMP_EMAIL]);
  await restore(snap);
});

describe('creating and changing events', () => {
  test('PR creates an event and assigns a student: in-app, email and audit_log', async () => {
    const e = await create({ assignees: [{ userId: ids.student, duty: 'ช่างภาพ' }] });
    assert.equal(e.visibility, 'internal', 'internal unless asked');
    assert.equal(e.status, 'scheduled');
    assert.deepEqual(e.assignees.map((a) => a.duty), ['ช่างภาพ']);
    assert.equal((await notes(student, e.id))[0].kind, 'event.assigned');
    assert.equal((await one(`select count(*)::int n from email_outbox where kind = 'event.assigned' and ref = $1`, [e.id])).n, 1);
    assert.equal((await one(`select count(*)::int n from audit_log where action = 'event.create' and target = $1`, [e.id])).n, 1);
  });
  test('admin may too; everyone else may not', async () => {
    assert.equal((await admin.call('POST', '/api/calendar/events', event())).status, 201);
    for (const who of [student, executive]) assert.equal((await who.call('POST', '/api/calendar/events', event())).status, 403);
  });
  test('bad input is refused', async () => {
    const bad = [
      { title: '' }, { type: 'party' }, { visibility: 'everyone' }, { startAt: 'พรุ่งนี้' },
      { endAt: later(1), startAt: later(2) },
      { startAt: '2569-11-05T09:00:00+07:00', endAt: '2569-11-05T10:00:00+07:00' },
      { startAt: '2027-02-31T09:00:00+07:00', endAt: '2027-03-05T10:00:00+07:00' },
      { assignees: 'all' },
      { assignees: [{ userId: 'not-an-id', duty: 'ช่างภาพ' }] },
      { assignees: [{ userId: ids.student, duty: '' }] },
      { assignees: [{ userId: ids.student, duty: 'ก' }, { userId: ids.student, duty: 'ข' }] },
      { assignees: [{ userId: '00000000-0000-4000-8000-000000000000', duty: 'ช่างภาพ' }] },
    ];
    for (const over of bad) assert.equal((await pr.call('POST', '/api/calendar/events', event(over))).status, 400, JSON.stringify(over));
  });
  test('only the PR team and students can be assigned', async () => {
    for (const userId of [ids.staff, ids.external]) {
      assert.equal((await pr.call('POST', '/api/calendar/events', event({ assignees: [{ userId, duty: 'ช่างภาพ' }] }))).status, 400);
    }
    const people = (await pr.call('GET', '/api/calendar/people')).body.items.map((p) => p.id);
    assert.ok(people.includes(ids.student) && people.includes(ids.pr));
    assert.ok(!people.includes(ids.staff) && !people.includes(ids.external));
  });
  test('editing tells only the people just added; those taken off are gone', async () => {
    const e = await create({ assignees: [{ userId: ids.student, duty: 'ช่างภาพ' }] });
    const r = await pr.call('PUT', `/api/calendar/events/${e.id}`, event({ title: 'แก้ไขแล้ว', assignees: [{ userId: ids.student, duty: 'พิธีกร' }, { userId: ids.pr, duty: 'หัวหน้างาน' }] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.event.title, 'แก้ไขแล้ว');
    assert.equal((await notes(student, e.id)).length, 1, 'already assigned: not told again');
    assert.equal((await notes(pr, e.id)).length, 1);
    const gone = await pr.call('PUT', `/api/calendar/events/${e.id}`, event({ assignees: [{ userId: ids.pr, duty: 'หัวหน้างาน' }] }));
    assert.deepEqual(gone.body.event.assignees.map((a) => a.id), [ids.pr]);
    assert.equal((await student.call('GET', `/api/calendar/events/${e.id}`)).status, 403);
    assert.equal((await one(`select count(*)::int n from audit_log where action = 'event.update' and target = $1`, [e.id])).n, 2);
  });
  test('cancelling keeps the row, tells the people assigned, and it cannot be edited', async () => {
    const e = await create({ assignees: [{ userId: ids.student, duty: 'ช่างภาพ' }] });
    assert.equal((await secretary.call('POST', `/api/calendar/events/${e.id}/cancel`, {})).status, 403);
    const r = await pr.call('POST', `/api/calendar/events/${e.id}/cancel`, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.event.status, 'cancelled');
    assert.ok((await notes(student, e.id)).some((n) => n.kind === 'event.cancelled'));
    assert.equal((await pr.call('POST', `/api/calendar/events/${e.id}/cancel`, {})).status, 409);
    assert.equal((await pr.call('PUT', `/api/calendar/events/${e.id}`, event())).status, 409);
    const inList = async (who) => (await who.call('GET', `/api/calendar/events?${RANGE}`)).body.items.some((x) => x.id === e.id);
    assert.equal(await inList(pr), true, 'the team still sees it');
    assert.equal(await inList(secretary), false);
    assert.equal(await inList(student), false);
    assert.equal((await one(`select count(*)::int n from audit_log where action = 'event.cancel' and target = $1`, [e.id])).n, 1);
  });
});

describe('who sees what (SPEC §2)', () => {
  test('secretaries and executives see every event, without the internal note', async () => {
    const e = await create({ assignees: [{ userId: ids.student, duty: 'ช่างภาพ' }] });
    for (const who of [secretary, executive]) {
      const list = await who.call('GET', `/api/calendar/events?${RANGE}`);
      assert.equal(list.status, 200);
      const row = list.body.items.find((x) => x.id === e.id);
      assert.deepEqual(row.assignees.map((a) => a.duty), ['ช่างภาพ']);
      assert.ok(!JSON.stringify(list.body).includes(NOTE), 'no note in the list');
      assert.ok(!JSON.stringify((await who.call('GET', `/api/calendar/events/${e.id}`)).body).includes(NOTE), 'no note in the event');
    }
    assert.equal((await pr.call('GET', `/api/calendar/events/${e.id}`)).body.event.internalNote, NOTE);
  });
  test('a student sees only events they are on, with who else works on them', async () => {
    const mine = await create({ assignees: [{ userId: ids.student, duty: 'ช่างภาพ' }, { userId: ids.pr, duty: 'หัวหน้างาน' }] });
    const other = await create();
    const ids2 = (await student.call('GET', `/api/calendar/events?${RANGE}`)).body.items.map((x) => x.id);
    assert.ok(ids2.includes(mine.id) && !ids2.includes(other.id));
    const r = await student.call('GET', `/api/calendar/events/${mine.id}`);
    assert.equal(r.body.event.assignees.length, 2);
    assert.equal(r.body.event.myDuty, 'ช่างภาพ');
    assert.ok(!JSON.stringify(r.body).includes(NOTE));
    assert.ok(!JSON.stringify(r.body).includes('@'), 'no email addresses');
    assert.equal((await student.call('GET', `/api/calendar/events/${other.id}`)).status, 403, 'an edited URL');
  });
  test('staff and external accounts get 403, signed out 401, on every back-office route', async () => {
    const e = await create();
    const routes = [['GET', `/api/calendar/events?${RANGE}`], ['GET', `/api/calendar/events/${e.id}`], ['GET', '/api/calendar/people'], ['POST', '/api/calendar/events'], ['PUT', `/api/calendar/events/${e.id}`], ['POST', `/api/calendar/events/${e.id}/cancel`]];
    for (const [m, path] of routes) {
      const body = m === 'GET' ? undefined : event();
      assert.equal((await staff.call(m, path, body)).status, 403, `staff ${m} ${path}`);
      assert.equal((await external.call(m, path, body)).status, 403, `external ${m} ${path}`);
      assert.equal((await anon.call(m, path, body)).status, 401, `signed out ${m} ${path}`);
    }
    assert.equal((await student.call('GET', '/api/calendar/people')).status, 403, 'the people list is for those who assign');
    assert.equal((await executive.call('GET', '/api/calendar/people')).status, 403);
  });
  test('dates are checked on the list', async () => {
    assert.equal((await pr.call('GET', '/api/calendar/events')).status, 400);
    assert.equal((await pr.call('GET', '/api/calendar/events?from=2027-02-31&to=2027-03-05')).status, 400);
    assert.equal((await pr.call('GET', '/api/calendar/events?from=2027-03-05&to=2027-03-01')).status, 400);
    assert.equal((await pr.call('GET', '/api/calendar/events?from=2020-01-01&to=2027-01-01')).status, 400, 'too long a range');
    assert.equal((await pr.call('GET', '/api/calendar/events/not-an-id')).status, 404);
  });
});

describe('secretaries', () => {
  const NOTE2 = 'โน้ตของทีม PR';
  test('they create events, assign people, and the note they send is dropped', async () => {
    const r = await secretary.call('POST', '/api/calendar/events', event({ internalNote: 'เลขาแอบใส่', assignees: [{ userId: ids.student, duty: 'ช่างภาพ' }] }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.event.canEdit, true);
    assert.ok(!('internalNote' in r.body.event));
    assert.equal((await pr.call('GET', `/api/calendar/events/${r.body.event.id}`)).body.event.internalNote, null);
    assert.equal((await notes(student, r.body.event.id)).length, 1);
    assert.equal((await one(`select count(*)::int n from audit_log where action = 'event.create' and target = $1`, [r.body.event.id])).n, 1);
  });
  test('they edit and cancel their own events; a note PR added survives and stays hidden', async () => {
    const { event: e } = (await secretary.call('POST', '/api/calendar/events', event())).body;
    assert.deepEqual(e.assignees, []);
    await pr.call('PUT', `/api/calendar/events/${e.id}`, event({ internalNote: NOTE2 }));
    const r = await secretary.call('PUT', `/api/calendar/events/${e.id}`, event({ title: 'เลขาแก้ไข', internalNote: '', assignees: [{ userId: ids.student, duty: 'พิธีกร' }] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.event.title, 'เลขาแก้ไข');
    assert.equal(r.body.event.assignees[0].id, ids.student, 'the ids the form needs');
    assert.ok(!JSON.stringify(r.body).includes(NOTE2));
    assert.equal((await pr.call('GET', `/api/calendar/events/${e.id}`)).body.event.internalNote, NOTE2);
    assert.equal((await secretary.call('POST', `/api/calendar/events/${e.id}/cancel`, {})).status, 200);
  });
  test('events made by others stay out of reach, and stay marked so', async () => {
    const theirs = await create({ assignees: [{ userId: ids.student, duty: 'ช่างภาพ' }] });
    assert.equal((await secretary.call('PUT', `/api/calendar/events/${theirs.id}`, event({ title: 'แอบแก้' }))).status, 403);
    assert.equal((await secretary.call('POST', `/api/calendar/events/${theirs.id}/cancel`, {})).status, 403);
    const seen = (await secretary.call('GET', `/api/calendar/events/${theirs.id}`)).body.event;
    assert.equal(seen.canEdit, false);
    assert.ok(!('id' in seen.assignees[0]), 'no user ids on events they cannot change');
    assert.notEqual((await pr.call('GET', `/api/calendar/events/${theirs.id}`)).body.event.title, 'แอบแก้');
    const mine = (await secretary.call('POST', '/api/calendar/events', event())).body.event;
    assert.equal((await pr.call('GET', `/api/calendar/events/${mine.id}`)).body.event.canEdit, true, 'PR may change them too');
    assert.equal((await executive.call('GET', `/api/calendar/events/${mine.id}`)).body.event.canEdit, false);
  });
  test('the people list has names, no email addresses, and is searched by name only', async () => {
    const r = await secretary.call('GET', '/api/calendar/people');
    assert.equal(r.status, 200);
    assert.ok(r.body.items.some((p) => p.id === ids.student));
    assert.ok(!JSON.stringify(r.body).includes('@'));
    assert.equal((await secretary.call('GET', '/api/calendar/people?q=student.sru.ac.th')).body.items.length, 0);
    assert.ok((await pr.call('GET', '/api/calendar/people?q=student.sru.ac.th')).body.items.length > 0);
  });
});

describe('calendar.html', () => {
  test('the page is served, not for search engines, and holds no data of its own', async () => {
    const r = await anon.call('GET', '/calendar.html');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('x-robots-tag') || '', /noindex/);
  });
  test('the menu opens the pages that are built and no others', async () => {
    const js = String((await anon.call('GET', '/auth.js')).body);
    const entries = [...js.matchAll(/\{ id: '(\w+)', href: '\w+\.html', label: '[^']+',( soon: true,)? icon:/g)];
    assert.deepEqual(entries.filter((m) => !m[2]).map((m) => m[1]), ['calendar', 'requests', 'documents', 'phonebook']);
    assert.equal(entries.length, 5);
  });
});

describe('public calendar', () => {
  test('public events only, four fields, for anyone', async () => {
    const open = await create({ visibility: 'public', title: 'กิจกรรมสาธารณะทดสอบ', assignees: [{ userId: ids.student, duty: 'ช่างภาพ' }] });
    const closed = await create({ title: 'กิจกรรมภายในทดสอบ' });
    const dropped = await create({ visibility: 'public', title: 'กิจกรรมยกเลิกทดสอบ' });
    await pr.call('POST', `/api/calendar/events/${dropped.id}/cancel`, {});
    const r = await anon.call('GET', `/api/calendar/public?${RANGE}`);
    assert.equal(r.status, 200);
    const row = r.body.items.find((x) => x.title === open.title);
    assert.deepEqual(Object.keys(row).sort(), ['endAt', 'location', 'startAt', 'title']);
    const all = JSON.stringify(r.body);
    for (const hidden of [closed.title, dropped.title, NOTE, 'ช่างภาพ', 'รายละเอียดทดสอบ']) assert.ok(!all.includes(hidden), hidden);
  });
});

describe('notifications', () => {
  test('the day-before reminder goes once, and again if the event moves', async () => {
    const e = await create({ startAt: later(24), endAt: later(26), assignees: [{ userId: ids.student, duty: 'ช่างภาพ' }] });
    await eventReminders();
    await eventReminders();
    const reminders = async () => (await notes(student, e.id)).filter((n) => n.kind === 'event.reminder').length;
    assert.equal(await reminders(), 1);
    assert.equal((await one(`select count(*)::int n from email_outbox where kind = 'event.reminder' and ref = $1`, [e.id])).n, 1);
    const body = (startAt, endAt) => event({ startAt, endAt, assignees: [{ userId: ids.student, duty: 'ช่างภาพ' }] });
    await pr.call('PUT', `/api/calendar/events/${e.id}`, body(later(24 * 3), later(24 * 3 + 2)));
    await pr.call('PUT', `/api/calendar/events/${e.id}`, body(later(24), later(26)));
    await eventReminders();
    assert.equal(await reminders(), 2);
  });
  test('no reminder for a cancelled event or one further away', async () => {
    const off = await create({ startAt: later(24), endAt: later(26), assignees: [{ userId: ids.student, duty: 'ช่างภาพ' }] });
    await pr.call('POST', `/api/calendar/events/${off.id}/cancel`, {});
    const far = await create({ startAt: later(24 * 4), endAt: later(24 * 4 + 2), assignees: [{ userId: ids.student, duty: 'ช่างภาพ' }] });
    await eventReminders();
    for (const e of [off, far]) assert.ok(!(await notes(student, e.id)).some((n) => n.kind === 'event.reminder'));
  });
  test('email can be turned off; the in-app notice stays', async () => {
    assert.ok((await student.call('GET', '/api/me/notify')).body.prefs.some((p) => p.key === 'assign'));
    assert.ok(!(await staff.call('GET', '/api/me/notify')).body.prefs.some((p) => p.key === 'assign'), 'staff are never assigned');
    assert.equal((await student.call('PUT', '/api/me/notify', { assign: false })).status, 200);
    const e = await create({ assignees: [{ userId: ids.student, duty: 'ช่างภาพ' }] });
    assert.equal((await notes(student, e.id)).length, 1);
    assert.equal((await one(`select count(*)::int n from email_outbox where kind = 'event.assigned' and ref = $1`, [e.id])).n, 0);
    await student.call('PUT', '/api/me/notify', { assign: true });
  });
  test('read marks are per person; someone else\'s notice answers 404', async () => {
    const e = await create({ assignees: [{ userId: ids.student, duty: 'ช่างภาพ' }] });
    const [n] = await notes(student, e.id);
    assert.equal(n.readAt, null);
    assert.equal((await pr.call('POST', `/api/notifications/${n.id}/read`, {})).status, 404);
    assert.equal((await student.call('POST', '/api/notifications/abc/read', {})).status, 404);
    assert.equal((await student.call('POST', `/api/notifications/${n.id}/read`, {})).status, 200);
    assert.ok((await notes(student, e.id))[0].readAt);
    await create({ assignees: [{ userId: ids.student, duty: 'ช่างภาพ' }] });
    assert.ok((await student.call('GET', '/api/notifications')).body.unread > 0);
    assert.equal((await student.call('POST', '/api/notifications/read-all', {})).status, 200);
    assert.equal((await student.call('GET', '/api/notifications')).body.unread, 0);
  });
  test('external accounts have no notifications; signed out 401', async () => {
    assert.equal((await external.call('GET', '/api/notifications')).status, 403);
    assert.equal((await staff.call('GET', '/api/notifications')).status, 200);
    assert.equal((await anon.call('GET', '/api/notifications')).status, 401);
  });
});

describe('PDPA', () => {
  test('my data includes assignments and notifications; erasing removes them', async () => {
    const e = await create({ assignees: [{ userId: ids.student, duty: 'หน้าที่ทดสอบ PDPA' }] });
    const data = (await student.call('GET', '/api/me/data')).body;
    assert.ok(data.calendarAssignments.some((a) => a.duty === 'หน้าที่ทดสอบ PDPA'));
    assert.ok(data.notifications.some((n) => n.ref_id === e.id));

    const { id } = await one(`insert into users (email, name, role) values ($1, 'ทดสอบลบ', 'student') returning id`, [TEMP_EMAIL]);
    const gone = await create({ assignees: [{ userId: id, duty: 'ช่างภาพ' }] });
    await tx((c) => erase(c, id));
    assert.equal((await one('select count(*)::int n from event_assignments where user_id = $1', [id])).n, 0);
    assert.equal((await one('select count(*)::int n from notifications where user_id = $1', [id])).n, 0);
    assert.equal((await pr.call('GET', `/api/calendar/events/${gone.id}`)).status, 200, 'the event stays');
  });
});
