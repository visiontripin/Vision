import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import {
  hashPassword,
  issueAccessToken,
  verifyAccessToken,
  verifyPassword,
} from '../src/platform/auth-crypto.js';
import {
  createArtistProfile,
  getCurrentUser,
  loginWithPassword,
  registerWithPassword,
  requireModerator,
  requireOwnerOrAdmin,
  revokeRefreshToken,
  rotateRefreshToken,
  updateCurrentUserProfile,
} from '../src/platform/identity.js';
import { runPlatformMigrations } from '../src/platform/migrations.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/platform/migrations/', import.meta.url));
const AUTH_SECRET = 'test-platform-secret-with-at-least-32-bytes';
let database;
let pool;

async function applyPlatformMigrations() {
  database = new PGlite({ extensions: { vector } });
  await database.waitReady;
  const query = async (sql, values) => {
    if (values?.length) return database.query(sql, values);
    const results = await database.exec(sql);
    return results.at(-1) ?? { rows: [] };
  };
  const client = { query, release() {} };
  pool = { connect: async () => client, query };
  await runPlatformMigrations(pool, { directory: MIGRATIONS_DIR });
}

before(applyPlatformMigrations);
after(async () => {
  if (database) await database.close();
});

describe('platform identity and authorization', () => {
  test('scrypt passwords and short-lived signed access tokens reject tampering/expiry', async () => {
    const password = 'correct horse battery staple';
    const hash = await hashPassword(password);
    assert.match(hash, /^scrypt\$16384\$8\$1\$/);
    assert.equal(await verifyPassword(password, hash), true);
    assert.equal(await verifyPassword('wrong password', hash), false);
    await assert.rejects(hashPassword('short'), /at least 12 characters/);

    const nowMs = Date.now();
    const access = issueAccessToken('c3eb16cc-cc34-4825-9a7e-d8afc3e2c09a', AUTH_SECRET, nowMs);
    assert.equal(verifyAccessToken(access.token, AUTH_SECRET, nowMs).sub, 'c3eb16cc-cc34-4825-9a7e-d8afc3e2c09a');
    assert.equal(verifyAccessToken(access.token, AUTH_SECRET, nowMs + 16 * 60_000), null);
    assert.equal(verifyAccessToken(`${access.token}x`, AUTH_SECRET, nowMs), null);
    assert.equal(verifyAccessToken(access.token, 'different-secret-at-least-32-bytes', nowMs), null);
  });

  test('registration, normalized email login and profile lookup work; duplicate email is safe', async () => {
    const registered = await registerWithPassword(pool, {
      email: '  Listener@Example.test ',
      password: 'sufficiently long test password',
      displayName: ' Listener One ',
    }, { secret: AUTH_SECRET });
    assert.equal(registered.user.email, 'listener@example.test');
    assert.equal(registered.user.displayName, 'Listener One');
    assert.equal(registered.user.role, 'listener');
    assert.equal(registered.tokenType, 'Bearer');
    assert.ok(registered.refreshToken);
    assert.ok(registered.accessToken);

    const current = await getCurrentUser(pool, registered.accessToken, { secret: AUTH_SECRET });
    assert.equal(current.id, registered.user.id);
    assert.equal(current.role, 'listener');

    const login = await loginWithPassword(pool, {
      email: 'LISTENER@example.test',
      password: 'sufficiently long test password',
    }, { secret: AUTH_SECRET });
    assert.equal(login.user.id, registered.user.id);
    await assert.rejects(
      registerWithPassword(pool, {
        email: 'listener@EXAMPLE.test',
        password: 'sufficiently long test password',
        displayName: 'Duplicate',
      }, { secret: AUTH_SECRET }),
      (error) => error.code === 'email_in_use' && error.status === 409,
    );
    await assert.rejects(
      loginWithPassword(pool, { email: 'listener@example.test', password: 'wrong password' }, { secret: AUTH_SECRET }),
      (error) => error.code === 'invalid_credentials' && error.status === 401,
    );
  });

  test('refresh rotation is single-use and replay revokes the user refresh sessions', async () => {
    const registered = await registerWithPassword(pool, {
      email: 'rotation@example.test',
      password: 'a different sufficiently long password',
      displayName: 'Rotation',
    }, { secret: AUTH_SECRET });
    const rotated = await rotateRefreshToken(pool, registered.refreshToken, { secret: AUTH_SECRET });
    assert.notEqual(rotated.refreshToken, registered.refreshToken);
    assert.equal(rotated.user.id, registered.user.id);

    await assert.rejects(
      rotateRefreshToken(pool, registered.refreshToken, { secret: AUTH_SECRET }),
      (error) => error.code === 'refresh_reuse' && error.status === 401,
    );
    await assert.rejects(
      rotateRefreshToken(pool, rotated.refreshToken, { secret: AUTH_SECRET }),
      (error) => error.code === 'invalid_refresh_token' && error.status === 401,
    );
    const sessions = await pool.query('SELECT revoked_at FROM refresh_sessions WHERE user_id = $1', [registered.user.id]);
    assert.equal(sessions.rows.length, 2);
    assert.ok(sessions.rows.every((session) => session.revoked_at));
  });

  test('explicit revocation and blocked-account checks invalidate further authentication', async () => {
    const registered = await registerWithPassword(pool, {
      email: 'blocked@example.test',
      password: 'yet another sufficiently long password',
      displayName: 'Blocked later',
    }, { secret: AUTH_SECRET });
    assert.equal(await revokeRefreshToken(pool, registered.refreshToken), true);
    assert.equal(await revokeRefreshToken(pool, registered.refreshToken), false);
    await assert.rejects(
      rotateRefreshToken(pool, registered.refreshToken, { secret: AUTH_SECRET }),
      (error) => error.code === 'invalid_refresh_token',
    );

    await pool.query("UPDATE users SET status = 'blocked' WHERE id = $1", [registered.user.id]);
    await assert.rejects(
      getCurrentUser(pool, registered.accessToken, { secret: AUTH_SECRET }),
      (error) => error.code === 'invalid_access_token',
    );
    await assert.rejects(
      loginWithPassword(pool, {
        email: 'blocked@example.test',
        password: 'yet another sufficiently long password',
      }, { secret: AUTH_SECRET }),
      (error) => error.code === 'invalid_credentials',
    );
  });

  test('artist activation requires explicit rights acknowledgement and role/ownership checks deny by default', async () => {
    const registered = await registerWithPassword(pool, {
      email: 'artist@example.test',
      password: 'a secure artist test password',
      displayName: 'Artist account',
    }, { secret: AUTH_SECRET });
    await assert.rejects(
      createArtistProfile(pool, registered.user.id, {
        stageName: 'Artist', offerVersion: 'test-terms-v1', rightsConfirmed: false,
      }),
      (error) => error.code === 'rights_confirmation_required',
    );

    const profile = await createArtistProfile(pool, registered.user.id, {
      stageName: 'Artist Stage',
      bio: 'Independent musician',
      links: ['https://artist.example.test'],
      offerVersion: 'test-terms-v1',
      rightsConfirmed: true,
    });
    assert.equal(profile.user_id, registered.user.id);
    assert.equal(profile.rights_confirmed_at instanceof Date || typeof profile.rights_confirmed_at === 'string', true);
    const current = await getCurrentUser(pool, registered.accessToken, { secret: AUTH_SECRET });
    assert.equal(current.role, 'artist');

    requireModerator({ id: registered.user.id, role: 'admin' });
    assert.throws(() => requireModerator(current), (error) => error.code === 'forbidden');
    assert.throws(
      () => requireOwnerOrAdmin(current, '9dfc115e-2591-4ef5-9b70-962b904a7868'),
      (error) => error.code === 'forbidden',
    );
    assert.equal(requireOwnerOrAdmin(current, registered.user.id).id, registered.user.id);
  });

  test('profile patch only touches allow-listed fields and validates values', async () => {
    const registered = await registerWithPassword(pool, {
      email: 'profile@example.test',
      password: 'profile update test password',
      displayName: 'Before',
    }, { secret: AUTH_SECRET });
    const updated = await updateCurrentUserProfile(pool, registered.user.id, {
      displayName: '  After  ',
      locale: 'en-GB',
      country: 'nl',
      city: 'Amsterdam',
      role: 'admin',
      email: 'other@example.test',
    });
    assert.equal(updated.displayName, 'After');
    assert.equal(updated.locale, 'en-GB');
    assert.equal(updated.country, 'NL');
    assert.equal(updated.city, 'Amsterdam');
    assert.equal(updated.role, 'listener');
    await assert.rejects(
      updateCurrentUserProfile(pool, registered.user.id, { locale: 'not a locale' }),
      (error) => error.code === 'invalid_input',
    );
    await assert.rejects(
      updateCurrentUserProfile(pool, registered.user.id, { primary_role: 'admin' }),
      (error) => error.code === 'invalid_input',
    );
  });
});
