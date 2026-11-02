// Sessions end 8 hours after the last use (SPEC.md §7); each use moves the end, at most once in 5 minutes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { one, query } from '../db.mjs';
import { login } from './helpers.mjs';

const HOUR = 60 * 60 * 1000;
const idOf = (who) => createHash('sha256').update(who.cookie.split('=')[1]).digest('hex');
const expiry = async (id) => new Date((await one('select expires_at from sessions where id = $1', [id])).expires_at).getTime();
const setExpiry = (id, at) => query('update sessions set expires_at = $2 where id = $1', [id, new Date(at)]);

let who, id;
before(async () => {
  who = await login('staff');
  id = idOf(who);
});
after(() => query('delete from sessions where id = $1', [id]));

describe('session idle timeout', () => {
  test('a new session ends in 8 hours', async () => {
    assert.ok(Math.abs(await expiry(id) - Date.now() - 8 * HOUR) < 60000);
  });
  test('using the site moves the end to 8 hours from now', async () => {
    await setExpiry(id, Date.now() + HOUR);
    assert.ok((await who.call('GET', '/api/me')).body.user);
    assert.ok(Math.abs(await expiry(id) - Date.now() - 8 * HOUR) < 60000);
  });
  test('a session used in the last 5 minutes is not written again', async () => {
    const end = Date.now() + 8 * HOUR - 60000;
    await setExpiry(id, end);
    await who.call('GET', '/api/me');
    assert.equal(await expiry(id), end);
  });
  test('a session past its end is signed out and stays out', async () => {
    await setExpiry(id, Date.now() - 1000);
    assert.ok(!(await who.call('GET', '/api/me')).body.user);
    assert.ok(await expiry(id) < Date.now());
  });
});
