// Applies server/migrations/*.sql in name order, each once, each in its own transaction.
// Usage: npm run db:migrate
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pool, tx } from './db.mjs';

const DIR = join(import.meta.dirname, 'migrations');

await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
const done = new Set((await pool.query('select name from schema_migrations')).rows.map((r) => r.name));
const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();

let applied = 0;
for (const name of files) {
  if (done.has(name)) continue;
  const sql = await readFile(join(DIR, name), 'utf8');
  await tx(async (c) => {
    await c.query(sql);
    await c.query('insert into schema_migrations (name) values ($1)', [name]);
  });
  console.log(`applied ${name}`);
  applied++;
}
console.log(applied ? `${applied} migration(s) applied` : 'database is up to date');
await pool.end();
