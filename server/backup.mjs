// npm run backup — nightly backup (run it from cron / Task Scheduler at night, see ops/BACKUP.md)
//   1. database: pg_dump (custom format) → BACKUP_DIR/db/prsru-YYYYMMDD-HHMM.dump, checked with pg_restore --list; kept 30 days
//   2. media (uploads/): an incremental snapshot every night → BACKUP_DIR/media/YYYY-MM-DD/ — files that did not change
//      since the previous snapshot are hard links to it (no extra space), new and changed ones are copied; kept 30 days.
//      Each snapshot has manifest.json (path, size, sha256 of every file) for the restore test.
//   3. off-site copy: BACKUP_OFFSITE_CMD, run with {dir} replaced by BACKUP_DIR, e.g.
//        rclone sync {dir} sru-backup:prsru        or        rsync -a --delete {dir}/ backup@nas.sru.ac.th:/backups/prsru/
//   4. BACKUP_DIR/status.json: what happened (admin.html → สำรองข้อมูล shows it). Exit code 1 when anything failed.
// Database access: PG_DUMP_VIA=docker (default: `docker compose exec db pg_dump`, the database container of this project)
// or PG_DUMP_VIA=local (pg_dump on PATH, using PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, link, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

export const ROOT = resolve(import.meta.dirname, '..');
export const BACKUP_DIR = resolve(ROOT, process.env.BACKUP_DIR || 'backups');
const UPLOADS = resolve(ROOT, process.env.UPLOAD_DIR || 'uploads');
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS) || 30;
const DB = process.env.PGDATABASE || 'prsru', USER = process.env.PGUSER || 'prsru';
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
const dayName = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Runs a program; stdout to a file or collected. Rejects with stderr on a non-zero exit.
export function run(cmd, args, { out, input, env, shell } = {}) {
  return new Promise((done, fail) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, shell, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let text = '', err = '';
    if (out) p.stdout.pipe(out); else p.stdout.on('data', (c) => { text += c; });
    p.stderr.on('data', (c) => { err += c; });
    if (input) createReadStream(input).pipe(p.stdin);
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? done(text) : fail(new Error(`${cmd} ${args.slice(0, 3).join(' ')}… exited ${code}: ${err.trim().slice(0, 400)}`))));
  });
}
// pg_dump / pg_restore / psql in the project's database container, or installed here
export function pgTool(tool, args, opts = {}) {
  if ((process.env.PG_DUMP_VIA || 'docker') === 'local') return run(tool, args, opts);
  return run('docker', ['compose', 'exec', '-T', 'db', tool, ...args], opts);
}
export const sha256 = async (file) => { const h = createHash('sha256'); await pipeline(createReadStream(file), h); return h.digest('hex'); };
export async function readStatus() { try { return JSON.parse(await readFile(join(BACKUP_DIR, 'status.json'), 'utf8')); } catch { return {}; } }
export async function writeStatus(patch) { const s = { ...(await readStatus()), ...patch }; await writeFile(join(BACKUP_DIR, 'status.json'), JSON.stringify(s, null, 2)); return s; }

// ---- 1. Database ----
async function backupDatabase() {
  const dir = join(BACKUP_DIR, 'db');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `prsru-${stamp()}.dump`);
  await pgTool('pg_dump', ['-U', USER, '-d', DB, '-Fc', '--no-owner'], { out: createWriteStream(file) });
  const { size } = await stat(file);
  if (size < 1024) throw new Error(`database dump is only ${size} bytes`);
  // The dump must list its tables; and the row counts the restore test compares against
  const list = await pgTool('pg_restore', ['--list'], { input: file });
  const tables = (list.match(/ TABLE DATA /g) || []).length;
  if (!tables) throw new Error('database dump lists no table data');
  const counts = JSON.parse((await pgTool('psql', ['-U', USER, '-d', DB, '-At', '-c',
    "select json_build_object('news', (select count(*) from news), 'users', (select count(*) from users), 'submissions', (select count(*) from submissions), 'submission_files', (select count(*) from submission_files), 'audit_log', (select count(*) from audit_log), 'news_revisions', (select count(*) from news_revisions))"])).trim());
  // Next to the dump: what it should contain (the restore test compares against this, not against the live database)
  await writeFile(`${file}.json`, JSON.stringify({ at: new Date().toISOString(), tables, counts }));
  return { file: relative(BACKUP_DIR, file).replaceAll('\\', '/'), size, tables, counts };
}

// ---- 2. Media, incremental ----
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (relative(UPLOADS, p) !== 'tmp') yield* walk(p); } else if (e.isFile()) yield p;
  }
}
async function backupMedia() {
  const root = join(BACKUP_DIR, 'media');
  await mkdir(root, { recursive: true });
  const today = dayName();
  const snaps = (await readdir(root)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d !== today).sort();
  const prevDir = snaps.length ? join(root, snaps.at(-1)) : null;
  let prev = {};
  if (prevDir) try { prev = Object.fromEntries(JSON.parse(await readFile(join(prevDir, 'manifest.json'), 'utf8')).files.map((f) => [f.path, f])); } catch {}
  const dest = join(root, today);
  await rm(dest, { recursive: true, force: true }); // a second run on the same day starts the day's snapshot again
  await mkdir(dest, { recursive: true }); // made even when uploads/ is still empty, so the manifest has a place
  const files = [];
  let copied = 0, linked = 0, bytesCopied = 0;
  for await (const src of walk(UPLOADS)) {
    const rel = relative(UPLOADS, src).replaceAll('\\', '/');
    const st = await stat(src);
    const out = join(dest, ...rel.split('/'));
    await mkdir(join(out, '..'), { recursive: true });
    const before = prev[rel];
    if (before && before.size === st.size && before.mtime === Math.round(st.mtimeMs)) {
      await link(join(prevDir, ...rel.split('/')), out); // unchanged: the same file as last night
      files.push(before); linked++;
    } else {
      await copyFile(src, out);
      files.push({ path: rel, size: st.size, mtime: Math.round(st.mtimeMs), sha256: await sha256(out) });
      copied++; bytesCopied += st.size;
    }
  }
  await writeFile(join(dest, 'manifest.json'), JSON.stringify({ at: new Date().toISOString(), files }));
  return { dir: relative(BACKUP_DIR, dest).replaceAll('\\', '/'), files: files.length, bytes: files.reduce((a, f) => a + f.size, 0), copied, linked, bytesCopied, since: snaps.at(-1) || null };
}

// ---- Old backups ----
async function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  const gone = [];
  for (const f of await readdir(join(BACKUP_DIR, 'db')).catch(() => [])) {
    const m = f.match(/^prsru-(\d{4})(\d{2})(\d{2})-\d{4}\.dump$/);
    if (m && new Date(`${m[1]}-${m[2]}-${m[3]}T23:59:59`).getTime() < cutoff) { await rm(join(BACKUP_DIR, 'db', f)); await rm(join(BACKUP_DIR, 'db', `${f}.json`), { force: true }); gone.push(f); }
  }
  for (const d of await readdir(join(BACKUP_DIR, 'media')).catch(() => [])) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T23:59:59`).getTime() < cutoff) { await rm(join(BACKUP_DIR, 'media', d), { recursive: true, force: true }); gone.push(`media/${d}`); }
  }
  return gone;
}

// ---- 3. Off site ----
async function offsite() {
  const cmd = process.env.BACKUP_OFFSITE_CMD;
  if (!cmd) return { ok: false, skipped: true, note: 'BACKUP_OFFSITE_CMD is not set: no copy outside this machine' };
  const line = cmd.replaceAll('{dir}', BACKUP_DIR);
  await run(line, [], { shell: true });
  return { ok: true, command: cmd.split(' ')[0] };
}

export async function backup() {
  await mkdir(BACKUP_DIR, { recursive: true });
  const started = new Date();
  const result = { at: started.toISOString(), ok: true, errors: [] };
  for (const [key, step] of [['db', backupDatabase], ['media', backupMedia]]) {
    try { result[key] = await step(); } catch (err) { result.ok = false; result.errors.push(`${key}: ${err.message}`); }
  }
  try { result.pruned = await prune(); } catch (err) { result.errors.push(`prune: ${err.message}`); }
  // Off site only after a good local backup
  if (result.ok) { try { result.offsite = await offsite(); } catch (err) { result.offsite = { ok: false, error: err.message }; result.ok = false; result.errors.push(`offsite: ${err.message}`); } }
  result.seconds = Math.round((Date.now() - started) / 1000);
  await writeStatus({ backup: result });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const r = await backup();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
