// PostgreSQL pool. Connection settings come from PG* environment variables (see .env.example).
import pg from 'pg';

// Return DATE columns as 'YYYY-MM-DD' strings instead of JS Dates shifted by the time zone
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ max: 10 });

// pg only knows built-in array types; without this, audience[] etc. arrive as the string '{public,staff}'.
// Call once at startup, after migrations have created the enums.
export async function registerEnumArrays() {
  const { rows } = await pool.query(`select typarray from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where t.typtype = 'e' and n.nspname = 'public'`);
  const parseTextArray = pg.types.getTypeParser(1009); // text[]
  for (const r of rows) pg.types.setTypeParser(r.typarray, parseTextArray);
}

export const query = (text, params) => pool.query(text, params);
export const one = async (text, params) => (await pool.query(text, params)).rows[0] ?? null;

// Runs fn(client) inside a transaction; rolls back if it throws
// actor (the signed-in user): who made the changes in this transaction, for the story edit history (news_revisions
// trigger, migration 010) — set_config(..., true) lasts until the transaction ends
export async function tx(fn, actor) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (actor) await client.query("select set_config('app.actor', $1, true)", [JSON.stringify({ id: actor.id, email: actor.email, name: actor.name })]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
