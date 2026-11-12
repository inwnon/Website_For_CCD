// Whole-site restore from the web (chanon.html → นำเข้า / ส่งออก), for moving servers without SSH.
// Developer accounts only (DEVELOPERS in auth.mjs), never a plain admin.
// - POST /api/admin/restore/upload/:id?offset=N   one piece of a file (application/octet-stream, ≤ 32 MB); returns { size }.
//                                                 Pieces keep big files under the server's 5-minute request limit and
//                                                 let a broken upload go on from where it stopped (409 gives the size so far).
// - POST /api/admin/restore/db     { id, confirm }  a pg_dump -Fc file replaces the whole database. First a copy of the
//                                                 current database goes to uploads/.restore/; everything runs in one
//                                                 transaction (any error = nothing changed); then migrations, and every
//                                                 session is ended (sessions from the old server must not work here).
// - POST /api/admin/restore/files  { id }           a .tar.gz of uploads/ is unpacked into uploads/ (adds and overwrites,
//                                                 deletes nothing). Every entry is checked first: no absolute path, no ..,
//                                                 no links; tmp/ and .restore/ in the archive are skipped.
//   Both answer 202 { job } at once and work in the background, so no proxy cuts a restore that takes minutes.
// - GET  /api/restore-status/:job                  { state: running | done | failed, ... }. The job token (random, 128 bit)
//                                                 is the key, not the session: a database restore ends every session.
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { audit } from './audit.mjs';
import { requireAdmin } from './auth.mjs';
import { pgTool, run } from './backup.mjs';
import { query, registerEnumArrays } from './db.mjs';
import { UPLOAD_DIR } from './files.mjs';
import { HttpError } from './http.mjs';
import { limit } from './security.mjs';
import { load as loadSettings } from './settings.mjs';

export const router = Router();
router.use('/admin/restore', requireAdmin, (req, res, next) => {
  if (!req.user.developer) throw new HttpError(403, 'กู้คืนทั้งระบบได้เฉพาะบัญชีผู้พัฒนาระบบ');
  next();
});

export const CONFIRM = 'กู้คืนทั้งหมด';
const MB = 1024 * 1024;
const PIECE = 32 * MB;
const MAX_FILE = 3 * 1024 * MB;
const KEEP_SAFETY = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TMP = join(UPLOAD_DIR, 'tmp');
const SAFETY = join(UPLOAD_DIR, '.restore');
const DB = process.env.PGDATABASE || 'prsru', USER = process.env.PGUSER || 'prsru';
const pieceLimit = limit('restore-upload', { max: 400, windowMs: 60 * 60 * 1000 });
const runLimit = limit('restore-run', { max: 10, windowMs: 60 * 60 * 1000 });
let busy = false; // one restore at a time

const partOf = (id) => {
  if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(400, 'รหัสไฟล์ไม่ถูกต้อง');
  return join(TMP, `restore-${id.toLowerCase()}.part`);
};
const sizeOf = (file) => stat(file).then((s) => s.size, () => 0);
const stamp = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(/\D/g, '').slice(0, 12);

async function head(file, n) {
  const fh = await open(file, 'r');
  try { const buf = Buffer.alloc(n); await fh.read(buf, 0, n, 0); return buf; } finally { await fh.close(); }
}

// Pieces left behind by an upload nobody finished
async function dropStale() {
  const old = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of await readdir(TMP).catch(() => [])) {
    if (!name.startsWith('restore-')) continue;
    const s = await stat(join(TMP, name)).catch(() => null);
    if (s && s.mtimeMs < old) await rm(join(TMP, name), { force: true });
  }
}

router.post('/admin/restore/upload/:id', pieceLimit, async (req, res) => {
  const file = partOf(req.params.id);
  const offset = Number(req.query.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'ตำแหน่งไฟล์ไม่ถูกต้อง');
  if (!/^application\/octet-stream/.test(req.get('content-type') || '')) throw new HttpError(415, 'ส่งไฟล์แบบ application/octet-stream');
  await mkdir(TMP, { recursive: true });
  if (offset === 0) { await dropStale(); await rm(file, { force: true }); }
  const size = await sizeOf(file);
  if (size !== offset) return res.status(409).json({ error: 'ตำแหน่งไม่ตรงกับที่อัปโหลดไว้', size });
  let got = 0;
  req.on('data', (c) => {
    got += c.length;
    if (got > PIECE || offset + got > MAX_FILE) req.destroy(new HttpError(413, got > PIECE ? 'ชิ้นไฟล์ใหญ่เกิน 32 MB' : 'ไฟล์ใหญ่เกิน 3 GB'));
  });
  try {
    await pipeline(req, createWriteStream(file, { flags: 'a' }));
  } catch (err) {
    // Keep what arrived whole only up to the old size: the next try starts again from there
    const fh = await open(file, 'r+'); await fh.truncate(offset); await fh.close();
    throw err instanceof HttpError ? err : new HttpError(400, 'อัปโหลดชิ้นนี้ไม่สำเร็จ ลองใหม่');
  }
  res.json({ size: await sizeOf(file) });
});

// Background jobs: job token → { state, kind, at, ...result | error }. Kept a day, in memory only
// (a restart forgets them; the usage history still shows what finished).
const jobs = new Map();
const JOB = /^[0-9a-f]{32}$/;
function start(kind, file, work) {
  if (busy) throw new HttpError(409, 'กำลังกู้คืนอยู่ รอให้เสร็จก่อน');
  busy = true;
  for (const [k, j] of jobs) if (Date.now() - j.at > 24 * 60 * 60 * 1000) jobs.delete(k);
  const token = randomBytes(16).toString('hex');
  const job = { state: 'running', kind, at: Date.now() };
  jobs.set(token, job);
  work().then((result) => Object.assign(job, { state: 'done' }, result), (err) => {
    if (!(err instanceof HttpError)) console.error(`restore ${kind} failed:`, String(err?.message || err).slice(0, 300));
    Object.assign(job, { state: 'failed', error: err instanceof HttpError ? err.message : 'กู้คืนไม่สำเร็จ ดูรายละเอียดใน log ของเซิร์ฟเวอร์' });
  }).finally(async () => { busy = false; await rm(file, { force: true }); });
  return token;
}

router.get('/restore-status/:job', limit('restore-status', { max: 600, windowMs: 10 * 60 * 1000, by: 'ip' }), (req, res) => {
  if (!JOB.test(req.params.job)) throw new HttpError(400, 'รหัสงานไม่ถูกต้อง');
  const job = jobs.get(req.params.job);
  if (!job) throw new HttpError(404, 'ไม่พบงานนี้ เซิร์ฟเวอร์อาจเริ่มใหม่ระหว่างกู้คืน ดูผลที่ประวัติการใช้งาน');
  const out = { ...job };
  delete out.at;
  res.json(out);
});

router.post('/admin/restore/db', runLimit, async (req, res) => {
  const file = partOf(req.body?.id);
  if (req.body?.confirm !== CONFIRM) throw new HttpError(400, `พิมพ์คำว่า ${CONFIRM} เพื่อยืนยัน`);
  if ((await sizeOf(file)) < 1024) throw new HttpError(400, 'ไม่พบไฟล์ที่อัปโหลด หรือไฟล์เล็กเกินไป');
  const job = start('db', file, async () => {
    if ((await head(file, 5)).toString('latin1') !== 'PGDMP') throw new HttpError(400, 'ไฟล์นี้ไม่ใช่ไฟล์สำรองของ pg_dump (-Fc)');
    const list = await pgTool('pg_restore', ['--list'], { input: file }).catch(() => { throw new HttpError(400, 'เปิดไฟล์สำรองนี้ไม่ได้'); });
    const tables = (list.match(/ TABLE DATA /g) || []).length;
    if (!tables) throw new HttpError(400, 'ไฟล์สำรองนี้ไม่มีข้อมูลตาราง');
    // A copy of what is here now, in case the file was the wrong one
    await mkdir(SAFETY, { recursive: true });
    const safety = `before-restore-${stamp()}.dump`;
    await pgTool('pg_dump', ['-U', USER, '-d', DB, '-Fc', '--no-owner'], { out: createWriteStream(join(SAFETY, safety)) });
    const kept = (await readdir(SAFETY)).filter((n) => n.startsWith('before-restore-')).sort().reverse();
    for (const n of kept.slice(KEEP_SAFETY)) await rm(join(SAFETY, n), { force: true });
    try {
      await pgTool('pg_restore', ['-U', USER, '-d', DB, '--clean', '--if-exists', '--no-owner', '--single-transaction', '--exit-on-error'], { input: file });
    } catch (err) {
      throw new HttpError(400, `กู้คืนไม่สำเร็จ ฐานข้อมูลยังเป็นแบบเดิม: ${String(err.message).split(': ').slice(1).join(': ').slice(0, 300)}`);
    }
    await run(process.execPath, ['server/migrate.mjs']); // a dump from an older version gets the newer tables
    // The restore made the enum types anew (new OIDs) and brought its own settings: what this process learnt at startup is stale
    await registerEnumArrays();
    await loadSettings();
    await query('delete from sessions');
    // The restored users table has its own ids: find this account in it again (or only the email)
    const me = (await query('select id, email from users where lower(email) = lower($1)', [req.user.email])).rows[0] ?? { email: req.user.email };
    await audit(null, me, 'data.restore', null, `กู้คืนฐานข้อมูลทั้งหมดจากไฟล์ (${tables} ตาราง) สำเนาก่อนกู้คืน: ${safety}`, { tables, safety });
    return { tables, safety };
  });
  res.status(202).json({ job });
});

// Folders of uploads/ the archive may carry but that are never unpacked: half-finished uploads and restore copies
const SKIP = ['tmp', '.restore'];

// Every entry of the archive must land inside uploads/. Returns how many leading folders to strip, the --exclude
// patterns for the skipped folders (as the names stand in the archive), and how many files will be unpacked.
export function checkEntries(names, kinds) {
  if (!names.length) throw new HttpError(400, 'ไม่พบไฟล์ในไฟล์บีบอัด');
  if (kinds.some((k) => k !== '-' && k !== 'd')) throw new HttpError(400, 'ไฟล์บีบอัดมีลิงก์หรือไฟล์พิเศษ ไม่นำเข้า');
  const dot = names.some((n) => n.startsWith('./'));
  const clean = names.map((n) => n.replace(/^\.\//, ''));
  const strip = clean.every((n) => n === 'uploads/' || n === 'uploads' || n.startsWith('uploads/')) ? 1 : 0;
  let files = 0;
  clean.forEach((n, i) => {
    const rest = (strip ? n.replace(/^uploads\/?/, '') : n).replace(/\/$/, '');
    if (!rest) return;
    const parts = rest.split('/');
    if (/^[/\\]|^[a-z]:/i.test(n) || n.includes('\\') || parts.some((p) => p === '..' || p === '')) {
      throw new HttpError(400, `ไฟล์บีบอัดมีตำแหน่งที่ไม่อนุญาต: ${n.slice(0, 120)}`);
    }
    if (!SKIP.includes(parts[0]) && kinds[i] === '-') files++;
  });
  const exclude = SKIP.map((s) => `${dot ? './' : ''}${strip ? 'uploads/' : ''}${s}`);
  return { strip, exclude, files };
}

router.post('/admin/restore/files', runLimit, async (req, res) => {
  const file = partOf(req.body?.id);
  if (!(await sizeOf(file))) throw new HttpError(400, 'ไม่พบไฟล์ที่อัปโหลด');
  const magic = await head(file, 2);
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) { await rm(file, { force: true }); throw new HttpError(400, 'ใช้ไฟล์ .tar.gz'); }
  const job = start('files', file, async () => {
    const fail = () => { throw new HttpError(400, 'เปิดไฟล์บีบอัดนี้ไม่ได้'); };
    const names = (await run('tar', ['-tzf', file]).catch(fail)).split('\n').filter(Boolean);
    const kinds = (await run('tar', ['-tvzf', file]).catch(fail)).split('\n').filter(Boolean).map((l) => l[0]);
    if (kinds.length !== names.length) fail();
    const { strip, exclude, files } = checkEntries(names, kinds);
    await run('tar', ['-xzf', file, '-C', UPLOAD_DIR, '-o', ...(strip ? ['--strip-components=1'] : []), ...exclude.map((e) => `--exclude=${e}`)]).catch(fail);
    await audit(null, req.user, 'data.restore_files', null, `กู้คืนไฟล์อัปโหลด ${files.toLocaleString('en-US')} ไฟล์จากไฟล์บีบอัด`, { files });
    return { files };
  });
  res.status(202).json({ job });
});
