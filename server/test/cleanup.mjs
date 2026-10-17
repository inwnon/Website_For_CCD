// Removes what a test run created, so `npm test` leaves the dev database and uploads/ as it found them.
// snapshot() before the tests, restore() after: everything the dev-login accounts created since the snapshot is deleted
// (submissions, stories, their files, saved stories, read counts, history, emails) and the ref counters, digests and
// notification settings, profile photos, names and phones go back to their old values.
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pool, query } from '../db.mjs';
import { abs, removeSubmissionDir } from '../files.mjs';

// Same addresses as DEV in auth.mjs
const DEV_EMAILS = ['user@sru.ac.th', 'user@student.sru.ac.th', 'user@gmail.com', 'pr@sru.ac.th', 'admin@sru.ac.th', 'coord@sru.ac.th'];
const tableExists = async (t) => (await query('select to_regclass($1) t', [t])).rows[0].t !== null;

export async function snapshot() {
  return {
    at: (await query('select now() t')).rows[0].t,
    counters: (await query('select * from ref_counters')).rows,
    settings: (await tableExists('settings')) ? (await query('select key, value from settings')).rows : null,
    digests: (await query('select * from digests')).rows,
    notify: (await query('select email, notify, photo_path, name, first_name, last_name, phone from users where email = any($1)', [DEV_EMAILS])).rows,
  };
}

export async function restore(snap) {
  const devIds = (await query('select id from users where email = any($1)', [DEV_EMAILS])).rows.map((r) => r.id);
  const subs = (await query('select id from submissions where sender_id = any($1) and sent_at >= $2', [devIds, snap.at])).rows.map((r) => r.id);
  const news = (await query('select id from news where created_at >= $2 and (created_by = any($1) or submission_id = any($3))', [devIds, snap.at, subs])).rows.map((r) => r.id);
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (await tableExists('audit_log')) await client.query('delete from audit_log where at >= $1 and (actor_id = any($2) or actor_id is null)', [snap.at, devIds]);
    await client.query('delete from news where id = any($1)', [news]); // saved_news and read counts cascade
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
    // Digests: back to how they were (issues made during the run are removed; the app makes them again)
    const keep = snap.digests.map((d) => d.id);
    await client.query('delete from digests where not (id = any($1))', [keep]);
    for (const d of snap.digests) {
      await client.query(`update digests set status = $2, mode = $3, groups = $4, edited = $5, cover_path = $6, cover_meta = $7, pdf_path = $8,
        pdf_meta = $9, shelf_path = $10, published_at = $11, approved_by = $12, drafted_at = $13 where id = $1`,
        [d.id, d.status, d.mode, JSON.stringify(d.groups), d.edited, d.cover_path, d.cover_meta && JSON.stringify(d.cover_meta), d.pdf_path,
          d.pdf_meta && JSON.stringify(d.pdf_meta), d.shelf_path, d.published_at, d.approved_by, d.drafted_at]);
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
    ...news.map((id) => rm(abs(join('media', id)), { recursive: true, force: true })),
  ]);
  // Digest files no row points to any more
  const used = new Set(snap.digests.flatMap((d) => [d.cover_path, d.pdf_path, d.shelf_path]).filter(Boolean).map((p) => p.replaceAll('\\', '/')));
  for (const dir of await readdir(abs('digests')).catch(() => [])) {
    for (const f of await readdir(abs(join('digests', dir))).catch(() => [])) {
      if (!used.has(`digests/${dir}/${f}`)) await rm(abs(join('digests', dir, f)), { force: true });
    }
  }
  // Profile photos no account points to any more
  const photos = new Set((await query('select photo_path from users where photo_path is not null')).rows.map((r) => r.photo_path));
  for (const f of await readdir(abs('avatars')).catch(() => [])) if (!photos.has(`avatars/${f}`)) await rm(abs(join('avatars', f)), { force: true });
  await pool.end();
  return { submissions: subs.length, news: news.length };
}
