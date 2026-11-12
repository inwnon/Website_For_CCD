// Whole-site restore (chanon.html → กู้คืนทั้งระบบ): developer accounts only, so a plain admin and every other role
// get 403 before any file is touched; and the archive check keeps every entry inside uploads/.
// The restore itself is not run here: it would replace the test database.
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { run } from '../backup.mjs';
import { checkEntries } from '../restore.mjs';
import { login, request } from './helpers.mjs';

// A program that stops reading its input early (pg_restore --list reads only the start of a dump) must not crash
// the app with EPIPE: this brought the app down on the first real restore
test('a program that exits before reading all its input is fine', async () => {
  const big = join(tmpdir(), `restore-epipe-${process.pid}.bin`);
  await writeFile(big, Buffer.alloc(16 * 1024 * 1024, 1));
  try {
    assert.equal(await run(process.execPath, ['-e', 'process.stdout.write("ok")'], { input: big }), 'ok');
    await assert.rejects(run(process.execPath, ['-e', 'process.exit(3)'], { input: big }), /exited 3/);
  } finally {
    await rm(big, { force: true });
  }
});

const ID = '00000000-0000-4000-8000-000000000000';
const piece = () => ({ 'Content-Type': 'application/octet-stream' });

describe('กู้คืนทั้งระบบ', () => {
  test('only developer accounts: admin and every other role get 403, nobody signed in gets 401', async () => {
    for (const as of ['admin', 'pr', 'staff', 'student', 'external', 'secretary', 'executive', 'coordinator']) {
      const u = await login(as);
      const up = await fetch(`${process.env.TEST_BASE || 'http://localhost:3000'}/api/admin/restore/upload/${ID}?offset=0`, {
        method: 'POST', headers: { ...piece(), cookie: u.cookie }, body: Buffer.from('PGDMP'),
      });
      assert.equal(up.status, 403, `${as} upload`);
      assert.equal((await u.call('POST', '/api/admin/restore/db', { id: ID, confirm: 'กู้คืนทั้งหมด' })).status, 403, `${as} db`);
      assert.equal((await u.call('POST', '/api/admin/restore/files', { id: ID })).status, 403, `${as} files`);
    }
    assert.equal((await request('POST', '/api/admin/restore/db', { id: ID, confirm: 'กู้คืนทั้งหมด' })).status, 401);
  });

  test('an archive made with tar -czf uploads.tar.gz uploads unpacks without its top folder; tmp/ and .restore/ are skipped', () => {
    assert.deepEqual(checkEntries(['uploads/', 'uploads/news/', 'uploads/news/a.webp', 'uploads/tmp/', 'uploads/tmp/x', 'uploads/.restore/b.dump'], ['d', 'd', '-', 'd', '-', '-']),
      { strip: 1, exclude: ['uploads/tmp', 'uploads/.restore'], files: 1 });
    assert.deepEqual(checkEntries(['./', './news/a.webp', './tmp/x'], ['d', '-', '-']), { strip: 0, exclude: ['./tmp', './.restore'], files: 1 });
    assert.deepEqual(checkEntries(['news/a.webp', 'documents/b.pdf'], ['-', '-']), { strip: 0, exclude: ['tmp', '.restore'], files: 2 });
  });

  test('the job status needs a well-formed token and forgets unknown jobs', async () => {
    assert.equal((await request('GET', '/api/restore-status/nope')).status, 400);
    assert.equal((await request('GET', `/api/restore-status/${'0'.repeat(32)}`)).status, 404);
  });

  test('entries that could land outside uploads/ are refused', () => {
    const bad = [
      [['uploads/../server/index.mjs'], ['-']],
      [['../x'], ['-']],
      [['/etc/passwd'], ['-']],
      [['C:/Windows/x'], ['-']],
      [['news\\..\\x'], ['-']],
      [['news/link'], ['l']],
      [['news/hard'], ['h']],
      [['uploads/tmp/../../x'], ['-']],
      [[], []],
    ];
    for (const [names, kinds] of bad) assert.throws(() => checkEntries(names, kinds), { status: 400 }, JSON.stringify(names));
  });
});
