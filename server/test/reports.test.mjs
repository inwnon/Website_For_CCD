// Report numbers (report.html): overdue counts only work waiting for PR review, a story published twice
// (ยกเลิกการเผยแพร่, then เผยแพร่อีกครั้ง) counts once and its time is to the first publish, working days never go below 0.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { query } from '../db.mjs';
import { login } from './helpers.mjs';

const UNIT = 'หน่วยทดสอบรายงาน';
let pr, report;
const ago = (days) => new Date(Date.now() - days * 86400000);

async function add(ref, status, sentDaysAgo, events = []) {
  const sender = (await query("select id from users where email = 'user@sru.ac.th'")).rows[0].id;
  const id = (await query(`insert into submissions (ref, type, status, sender_id, unit, title, audience, sent_at)
    values ($1, 'banner', $2, $3, $4, $5, '{public}', $6) returning id`, [ref, status, sender, UNIT, `งานทดสอบรายงาน ${ref}`, ago(sentDaysAgo)])).rows[0].id;
  for (const [st, daysAgo] of events) await query('insert into submission_events (submission_id, status, at) values ($1, $2, $3)', [id, st, ago(daysAgo)]);
}
const clean = async () => {
  await query('delete from submission_events where submission_id in (select id from submissions where unit = $1)', [UNIT]);
  await query('delete from submissions where unit = $1', [UNIT]);
};

before(async () => {
  pr = await login('pr');
  await clean();
  await add('RPT-T-1', 'review', 10);
  await add('RPT-T-2', 'writing', 10);
  await add('RPT-T-3', 'published', 5, [['published', 4], ['unpublished', 3], ['published', 2]]);
  const day = (d) => d.toISOString().slice(0, 10);
  const r = await pr.call('GET', `/api/reports?from=${day(ago(30))}&to=${day(new Date())}&unit=${encodeURIComponent(UNIT)}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  report = r.body.approval;
});
after(clean);

describe('รายงาน', () => {
  test('overdue counts only work waiting for PR review', () => {
    assert.equal(report.review, 1);
    assert.equal(report.writing, 1);
    assert.equal(report.late, 1);
  });
  test('a story published twice counts once, timed to its first publish', () => {
    assert.equal(report.published, 1);
    assert.equal(report.avgHours, 24);
    assert.equal(report.medianHours, 24);
  });
  test('working days never below 0', () => {
    assert.ok(report.oldest.workDays >= 0);
  });
});
