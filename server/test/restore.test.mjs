// Whole-site restore (chanon.html → กู้คืนทั้งระบบ): developer accounts only, so a plain admin and every other role
// get 403 before any file is touched; and the archive check keeps every entry inside uploads/.
// The restore itself is not run here: it would replace the test database.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkEntries } from '../restore.mjs';
import { login, request } from './helpers.mjs';

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

  test('an archive made with tar -czf uploads.tar.gz uploads unpacks without its top folder', () => {
    assert.equal(checkEntries(['uploads/', 'uploads/news/', 'uploads/news/a.webp'], ['d', 'd', '-']), 1);
    assert.equal(checkEntries(['./', './news/a.webp'], ['d', '-']), 0);
    assert.equal(checkEntries(['news/a.webp', 'documents/b.pdf'], ['-', '-']), 0);
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
      [['tmp/restore-x.part'], ['-']],
      [['uploads/.restore/before.dump'], ['-']],
      [[], []],
    ];
    for (const [names, kinds] of bad) assert.throws(() => checkEntries(names, kinds), { status: 400 }, JSON.stringify(names));
  });
});
