// Removes what a test run created, so `npm test` leaves the dev database and uploads/ as it found them.
// snapshot() before the tests, restore() after: everything the dev-login accounts created since the snapshot is deleted
// (submissions, drafts, stories, their files, saved stories, read counts, history, emails) and the ref counters and
// notification settings, profile photos, names and phones go back to their old values.
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pool, query } from '../db.mjs';
import { abs, removeDraftDir, removeSubmissionDir } from '../files.mjs';

// Same addresses as DEV in auth.mjs
const DEV_EMAILS = ['user@sru.ac.th', 'user@student.sru.ac.th', 'user@gmail.com', 'pr@sru.ac.th', 'admin@sru.ac.th', 'coord@sru.ac.th', 'intern@student.sru.ac.th', 'secretary@sru.ac.th', 'executive@sru.ac.th', 'satearnpong.nis@sru.ac.th'];
const tableExists = async (t) => (await query('select to_regclass($1) t', [t])).rows[0].t !== null;

export async function snapshot() {
  return {
    at: (await query('select now() t')).rows[0].t,
    counters: (await query('select * from ref_counters')).rows,
    settings: (await tableExists('settings')) ? (await query('select key, value from settings')).rows : null,
    notify: (await query('select email, notify, photo_path, name, first_name, last_name, phone from users where email = any($1)', [DEV_EMAILS])).rows,
  };
}

export async function restore(snap) {
  const devIds = (await query('select id from users where email = any($1)', [DEV_EMAILS])).rows.map((r) => r.id);
  const subs = (await query('select id from submissions where sender_id = any($1) and sent_at >= $2', [devIds, snap.at])).rows.map((r) => r.id);
  const news = (await query('select id from news where created_at >= $2 and (created_by = any($1) or submission_id = any($3))', [devIds, snap.at, subs])).rows.map((r) => r.id);
  const drafts = (await tableExists('submission_drafts')) ? (await query('select id from submission_drafts where sender_id = any($1) and created_at >= $2', [devIds, snap.at])).rows.map((r) => r.id) : [];
  let documents = [], events = [];
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (await tableExists('audit_log')) await client.query('delete from audit_log where at >= $1 and (actor_id = any($2) or actor_id is null)', [snap.at, devIds]);
    await client.query('delete from news where id = any($1)', [news]); // saved_news and read counts cascade
    if (await tableExists('service_requests')) await client.query('delete from service_requests where created_at >= $1 and requester_id = any($2)', [snap.at, devIds]);
    if (await tableExists('request_access')) await client.query('delete from request_access where asked_at >= $1 and email = any($2)', [snap.at, DEV_EMAILS]);
    if (await tableExists('events')) {
      events = (await client.query('delete from events where created_at >= $1 and created_by = any($2) returning id', [snap.at, devIds])).rows.map((r) => r.id); // assignments and banners cascade
      await client.query('delete from notifications where created_at >= $1', [snap.at]);
    }
    if (await tableExists('documents')) {
      documents = (await client.query('delete from documents where created_at >= $1 returning id', [snap.at])).rows.map((r) => r.id); // versions cascade
      await client.query('delete from document_works where created_at >= $1', [snap.at]);
    }
    if (await tableExists('collections')) await client.query('delete from collections where created_at >= $1 and created_by = any($2)', [snap.at, devIds]);
    // Reads counted during the run, on stories that stay (the seed stories)
    const reads = (await client.query('delete from news_reads where at >= $1 returning news_id, day, source, device', [snap.at])).rows;
    for (const r of reads) {
      await client.query('update news_reads_daily set n = n - 1 where news_id = $1 and day = $2 and source = $3 and device = $4', [r.news_id, r.day, r.source, r.device]);
      await client.query('update news set views = greatest(views - 1, 0) where id = $1', [r.news_id]);
    }
    await client.query('delete from news_reads_daily where n <= 0');
    // Roles given during the run (dev-login roles are re-added on the next dev login)
    const roles = (await client.query('delete from pr_team where added_at >= $1 returning email', [snap.at])).rows.map((r) => r.email);
    await client.query(`update users set role = case when email like '%@student.sru.ac.th' then 'student'::user_role when email like '%@sru.ac.th' then 'staff'::user_role else 'external'::user_role end
      where email = any($1) and email not in (select email from pr_team)`, [roles]);
    await client.query('delete from submissions where id = any($1)', [subs]);
    if (drafts.length) await client.query('delete from submission_drafts where id = any($1)', [drafts]);
    await client.query('delete from ref_counters');
    for (const c of snap.counters) await client.query('insert into ref_counters (prefix, year, last) values ($1, $2, $3)', [c.prefix, c.year, c.last]);
    if (snap.settings) {
      await client.query('delete from settings');
      for (const s of snap.settings) await client.query('insert into settings (key, value) values ($1, $2)', [s.key, JSON.stringify(s.value)]);
    }
    await client.query('delete from email_outbox where created_at >= $1', [snap.at]);
    // PDPA tests: requests, and accounts erased during the run (their unpublished work is already gone)
    await client.query('delete from data_requests where created_at >= $1', [snap.at]);
    await client.query('delete from users where erased_at >= $1 and not exists (select 1 from submissions s where s.sender_id = users.id)', [snap.at]);
    for (const u of snap.notify) {
      await client.query('update users set notify = $2, photo_path = $3, name = $4, first_name = $5, last_name = $6, phone = $7 where email = $1',
        [u.email, JSON.stringify(u.notify), u.photo_path, u.name, u.first_name, u.last_name, u.phone]);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
  await Promise.all([
    ...subs.map((id) => removeSubmissionDir(id)),
    ...drafts.map((id) => removeDraftDir(id)),
    ...news.map((id) => rm(abs(join('media', id)), { recursive: true, force: true })),
    ...documents.map((id) => rm(abs(join('documents', id)), { recursive: true, force: true })),
    ...events.map((id) => rm(abs(join('events', id)), { recursive: true, force: true })),
  ]);
  // Profile photos no account points to any more
  const photos = new Set((await query('select photo_path from users where photo_path is not null')).rows.map((r) => r.photo_path));
  for (const f of await readdir(abs('avatars')).catch(() => [])) if (!photos.has(`avatars/${f}`)) await rm(abs(join('avatars', f)), { force: true });
  await pool.end();
  return { submissions: subs.length, news: news.length };
}
