// npm run backup:restore-test — restores the latest backup for real, once a month (cron, see ops/BACKUP.md)
//   1. the newest dump in BACKUP_DIR/db goes into a fresh, empty PostgreSQL (a throwaway container, removed afterwards;
//      RESTORE_VIA=local: a temporary database on the PostgreSQL server of PGHOST instead)
//   2. the restored database must have the same rows as when the dump was made (the dump's .json), and its tables
//   3. the newest media snapshot: every file in its manifest is there with its size; a sample is checked by SHA-256;
//      every photo / file / story image the restored database points to exists in the snapshot
//   4. the result goes to BACKUP_DIR/status.json (chanon.html → สำรองข้อมูล). Exit code 1 when anything failed.
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BACKUP_DIR, run, sha256, writeStatus } from './backup.mjs';

const VIA = process.env.RESTORE_VIA || 'docker';
const IMAGE = process.env.RESTORE_IMAGE || 'postgres:16-alpine';
const SAMPLE = Number(process.env.RESTORE_SAMPLE) || 40;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// The checks are shown in chanon.html, in Thai
const TABLE = { news: 'ข่าว', users: 'ผู้ใช้', submissions: 'งานที่ส่ง', submission_files: 'ไฟล์แนบ', audit_log: 'ประวัติการใช้งาน', news_revisions: 'ประวัติการแก้ไขข่าว' };

async function latest(dir, re) {
  const names = (await readdir(dir).catch(() => [])).filter((n) => re.test(n)).sort();
  return names.length ? join(dir, names.at(-1)) : null;
}

// A database to restore into, and how to run psql / pg_restore against it
async function scratchDatabase() {
  const name = `prsru_restore_test_${Date.now()}`;
  if (VIA === 'local') {
    await run('createdb', [name]);
    return { name, tool: (t, args, o) => run(t, [...args, '-d', name], o), drop: () => run('dropdb', ['--if-exists', name]) };
  }
  const box = `prsru-restore-test-${Date.now()}`;
  await run('docker', ['run', '-d', '--rm', '--name', box, '-e', 'POSTGRES_PASSWORD=restore-test', '-e', 'POSTGRES_USER=prsru', '-e', `POSTGRES_DB=${name}`, IMAGE]);
  for (let i = 0; i < 60; i++) {
    try { await run('docker', ['exec', box, 'pg_isready', '-U', 'prsru', '-d', name]); await run('docker', ['exec', box, 'psql', '-U', 'prsru', '-d', name, '-c', 'select 1']); break; } catch { await wait(1000); }
  }
  return { name, tool: (t, args, o) => run('docker', ['exec', '-i', box, t, '-U', 'prsru', ...args, '-d', name], o), drop: () => run('docker', ['rm', '-f', box]).catch(() => {}) };
}

export async function restoreTest() {
  const started = new Date();
  const result = { at: started.toISOString(), ok: false, checks: [], errors: [] };
  const check = (ok, what) => { result.checks.push({ ok, what }); if (!ok) result.errors.push(what); };
  const dump = await latest(join(BACKUP_DIR, 'db'), /^prsru-\d{8}-\d{4}\.dump$/);
  const snapDir = await latest(join(BACKUP_DIR, 'media'), /^\d{4}-\d{2}-\d{2}$/);
  if (!dump) { result.errors.push('ไม่มีไฟล์สำรองฐานข้อมูลให้กู้คืน'); await writeStatus({ restoreTest: result }); return result; }
  result.dump = dump.split(/[\\/]/).slice(-2).join('/');
  result.snapshot = snapDir ? snapDir.split(/[\\/]/).slice(-2).join('/') : null;
  const expected = existsSync(`${dump}.json`) ? JSON.parse(await readFile(`${dump}.json`, 'utf8')) : null;
  let db;
  try {
    // 1. restore
    db = await scratchDatabase();
    await db.tool('pg_restore', ['--no-owner', '--exit-on-error'], { input: dump });
    const q = async (sql) => (await db.tool('psql', ['-At', '-c', sql])).trim();
    // 2. same rows as when it was made
    const tables = Number(await q("select count(*) from information_schema.tables where table_schema = 'public'"));
    check(tables >= 15, `กู้คืนฐานข้อมูลได้ ${tables} ตาราง`);
    if (expected) {
      const got = JSON.parse(await q("select json_build_object('news', (select count(*) from news), 'users', (select count(*) from users), 'submissions', (select count(*) from submissions), 'submission_files', (select count(*) from submission_files), 'audit_log', (select count(*) from audit_log), 'news_revisions', (select count(*) from news_revisions))"));
      for (const [k, v] of Object.entries(expected.counts)) check(got[k] === v, `${TABLE[k] || k}: ${got[k]} แถว (ตอนสำรองมี ${v})`);
    } else check(false, 'ไฟล์สำรองไม่มีจำนวนแถวไว้เทียบ (.json)');
    const migrations = Number(await q('select count(*) from schema_migrations').catch(() => '0'));
    check(migrations > 0, `โครงสร้างฐานข้อมูลครบ ${migrations} รุ่น`);
    // 3. media snapshot
    if (snapDir) {
      const manifest = JSON.parse(await readFile(join(snapDir, 'manifest.json'), 'utf8')).files;
      let missing = 0, wrongSize = 0;
      for (const f of manifest) {
        const p = join(snapDir, ...f.path.split('/'));
        if (!existsSync(p)) missing++; else if ((await stat(p)).size !== f.size) wrongSize++;
      }
      check(!missing && !wrongSize, `ไฟล์ภาพและเอกสาร ${manifest.length} ไฟล์ หาย ${missing} ขนาดไม่ตรง ${wrongSize}`);
      // (missing files are counted above; the sample is of the ones that are there)
      const sample = manifest.filter((f) => existsSync(join(snapDir, ...f.path.split('/')))).sort(() => Math.random() - 0.5).slice(0, SAMPLE);
      let bad = 0;
      for (const f of sample) if (f.sha256 && (await sha256(join(snapDir, ...f.path.split('/')))) !== f.sha256) bad++;
      check(!bad, `สุ่มตรวจเนื้อไฟล์ (SHA-256) ${sample.length} ไฟล์ ไม่ตรง ${bad}`);
      // what the restored database points to is in the snapshot
      const paths = (await q("select path from submission_files union all select 'media/' || cover_path from news where cover_path is not null union all select 'media/' || g from news, unnest(gallery) g"))
        .split('\n').filter(Boolean);
      const have = new Set(manifest.map((f) => f.path));
      const absent = paths.filter((p) => !have.has(p));
      check(!absent.length, `ไฟล์ที่ฐานข้อมูลอ้างถึง ${paths.length} ไฟล์ ไม่มีในสำเนา ${absent.length}${absent.length ? ` (เช่น ${absent[0]})` : ''}`);
    } else check(false, 'ไม่มีสำเนาไฟล์ภาพและเอกสาร');
    result.ok = result.errors.length === 0;
  } catch (err) {
    result.errors.push(err.message);
  } finally {
    if (db) await db.drop();
  }
  result.seconds = Math.round((Date.now() - started.getTime()) / 1000);
  await writeStatus({ restoreTest: result });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const r = await restoreTest();
  for (const c of r.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.what}`);
  if (r.errors.length) console.log('errors:', r.errors);
  console.log(r.ok ? `restore test passed (${r.seconds}s): ${r.dump}, ${r.snapshot}` : 'RESTORE TEST FAILED');
  process.exit(r.ok ? 0 : 1);
}
