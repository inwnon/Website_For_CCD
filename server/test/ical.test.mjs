// iCal feeds (SPEC.md item 16, §7): one public feed, one private read-only feed per user, random and revocable.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { one, query } from '../db.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { anon, login } from './helpers.mjs';

const HOUR = 60 * 60 * 1000;
const later = (hours) => new Date(Date.now() + hours * HOUR).toISOString();
const NOTE = 'โน้ตภายในห้ามหลุด';
const event = (over = {}) => ({ title: 'งานทดสอบฟีด', type: 'media', location: 'หอประชุม, ชั้น 2; ห้อง A', startAt: later(48), endAt: later(50),
  description: 'บรรทัดแรก\nบรรทัดสอง', internalNote: NOTE, assignees: [], ...over });

let snap, pr, admin, student, secretary, executive, staff, external, studentId;
const create = async (over) => {
  const r = await pr.call('POST', '/api/calendar/events', event(over));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.event;
};
const text = async (path) => {
  const r = await anon.call('GET', path);
  return { status: r.status, type: r.headers.get('content-type') || '', cache: r.headers.get('cache-control') || '', body: Buffer.from(r.body).toString('utf8') };
};
// Unfolds lines (RFC 5545 §3.1) so a value can be matched whole
const unfold = (s) => s.replace(/\r\n[ \t]/g, '');
const feedPath = (url) => new URL(url).pathname;
const newFeed = async (who) => {
  const r = await who.call('POST', '/api/calendar/feed', {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return feedPath(r.body.url);
};

before(async () => {
  snap = await snapshot();
  [pr, admin, student, secretary, executive, staff, external] = await Promise.all(['pr', 'admin', 'student', 'secretary', 'executive', 'staff', 'external'].map(login));
  studentId = (await student.call('GET', '/api/me')).body.user.id;
});
after(async () => {
  await query('delete from calendar_feeds');
  await restore(snap);
});

describe('public feed', () => {
  test('public events only: title, time and place, nothing internal', async () => {
    const pub = await create({ title: 'งานสาธารณะฟีด', visibility: 'public', assignees: [{ userId: studentId, duty: 'ช่างภาพฟีด' }] });
    await create({ title: 'งานภายในฟีด' });
    const r = await text('/ical/public.ics');
    assert.equal(r.status, 200);
    assert.match(r.type, /^text\/calendar/);
    const ics = unfold(r.body);
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.match(ics, /END:VCALENDAR\r\n$/);
    assert.ok(ics.includes('SUMMARY:งานสาธารณะฟีด'));
    assert.ok(ics.includes('LOCATION:หอประชุม\\, ชั้น 2\\; ห้อง A'), 'commas and semicolons escaped');
    assert.ok(!ics.includes('งานภายในฟีด'));
    for (const secret of [NOTE, 'ช่างภาพฟีด', 'บรรทัดแรก', pub.id, 'DESCRIPTION']) assert.ok(!ics.includes(secret), secret);
  });
  test('every line is at most 75 octets and ends with CRLF', async () => {
    await create({ title: 'ชื่อกิจกรรมยาวมาก'.repeat(8), visibility: 'public' });
    const { body } = await text('/ical/public.ics');
    assert.ok(!/[^\r]\n/.test(body), 'bare LF');
    for (const line of body.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
    assert.ok(unfold(body).includes(`SUMMARY:${'ชื่อกิจกรรมยาวมาก'.repeat(8)}`), 'folding keeps Thai characters whole');
  });
});

describe('private feed', () => {
  test('anyone with the calendar module gets a link; staff and external get 403', async () => {
    for (const who of [pr, admin, student, secretary, executive]) assert.equal((await who.call('POST', '/api/calendar/feed', {})).status, 201);
    for (const who of [staff, external, anon]) {
      assert.ok([401, 403].includes((await who.call('POST', '/api/calendar/feed', {})).status));
      assert.ok([401, 403].includes((await who.call('GET', '/api/calendar/feed')).status));
    }
  });
  test('the link is shown once; only its hash is stored; audit_log has it', async () => {
    const r = await pr.call('POST', '/api/calendar/feed', {});
    const token = /\/ical\/u\/([\w-]+)\.ics$/.exec(r.body.url)[1];
    assert.ok(token.length >= 43, 'at least 256 bits');
    assert.equal((await one('select count(*)::int n from calendar_feeds where token_hash = $1', [token])).n, 0, 'never stored as is');
    const status = (await pr.call('GET', '/api/calendar/feed')).body;
    assert.equal(status.active, true);
    assert.ok(!JSON.stringify(status).includes(token), 'not shown again');
    assert.ok((await one(`select count(*)::int n from audit_log where action = 'calendar.feed.create'`)).n >= 1);
  });
  test('PR sees internal events with own duty and description, never the internal note or other names', async () => {
    const e = await create({ title: 'งานภายในของทีม', assignees: [{ userId: studentId, duty: 'ช่างภาพหลัก' }] });
    const ics = unfold((await text(await newFeed(pr))).body);
    assert.ok(ics.includes('SUMMARY:งานภายในของทีม'));
    assert.ok(ics.includes('บรรทัดแรก\\nบรรทัดสอง'), 'newlines escaped');
    assert.ok(!ics.includes(NOTE));
    assert.ok(!ics.includes('ช่างภาพหลัก'), 'not PR\'s own duty');
    assert.ok(!ics.includes(e.id), 'UID does not reveal the event id');
  });
  test('a student sees only the events they are on, with their duty', async () => {
    await create({ title: 'งานที่นักศึกษาอยู่', assignees: [{ userId: studentId, duty: 'ถ่ายวิดีโอ' }] });
    await create({ title: 'งานที่นักศึกษาไม่อยู่' });
    const r = await text(await newFeed(student));
    assert.equal(r.status, 200);
    assert.match(r.cache, /no-store/);
    const ics = unfold(r.body);
    assert.ok(ics.includes('SUMMARY:งานที่นักศึกษาอยู่'));
    assert.ok(ics.includes('ถ่ายวิดีโอ'));
    assert.ok(!ics.includes('งานที่นักศึกษาไม่อยู่'));
    assert.ok(!ics.includes(NOTE));
  });
  test('a new link replaces the old one; revoking stops it', async () => {
    const first = await newFeed(secretary);
    const second = await newFeed(secretary);
    assert.equal((await text(first)).status, 404);
    assert.equal((await text(second)).status, 200);
    assert.equal((await secretary.call('DELETE', '/api/calendar/feed')).status, 200);
    assert.equal((await text(second)).status, 404);
    assert.equal((await secretary.call('GET', '/api/calendar/feed')).body.active, false);
    assert.ok((await one(`select count(*)::int n from audit_log where action = 'calendar.feed.revoke'`)).n >= 1);
  });
  test('the link stops when its owner loses the calendar, and for made-up tokens', async () => {
    const path = await newFeed(executive);
    const { id } = (await executive.call('GET', '/api/me')).body.user;
    await query(`update users set erased_at = now() where id = $1`, [id]);
    assert.equal((await text(path)).status, 404);
    await query(`update users set erased_at = null where id = $1`, [id]);
    for (const p of ['/ical/u/not-a-token.ics', `/ical/u/${'A'.repeat(43)}.ics`, '/ical/u/.ics']) assert.equal((await text(p)).status, 404, p);
  });
});
