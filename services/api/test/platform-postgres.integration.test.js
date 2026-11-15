import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformPool } from '../src/platform/postgres.js';
import { runPlatformMigrations } from '../src/platform/migrations.js';
import { registerWithPassword, getCurrentUser, rotateRefreshToken } from '../src/platform/identity.js';
import { createPlatformServer } from '../src/platform/server.js';

const DATABASE_URL = process.env.PLATFORM_DATABASE_URL;
const AUTH_SECRET = process.env.PLATFORM_AUTH_SECRET || 'ci-postgres-integration-secret-32-bytes-min';
const MIGRATION_NAMES = [
  '001_identity_catalog.sql',
  '002_events_recsys.sql',
  '003_radio_voice.sql',
  '004_rights_moderation_audit.sql',
  '005_server_runtime.sql',
  '006_voice_storage.sql',
  '007_tts_cost_ledger.sql',
];

test('platform stack works on PostgreSQL 16 with pgvector', {
  skip: !DATABASE_URL && 'Set PLATFORM_DATABASE_URL to run the real PostgreSQL integration test.',
}, async () => {
  const pool = createPlatformPool({ connectionString: DATABASE_URL, max: 4 });
  let server;
  try {
    const version = await pool.query('SHOW server_version_num');
    assert.ok(Number(version.rows[0].server_version_num) >= 160000, 'PostgreSQL 16 or newer is required.');

    // This job owns a disposable database. Resetting public gives the test a clean
    // migration target and ensures the pgvector extension is installed by our SQL.
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');

    // Exercise the migration advisory lock with two independent connections.
    const [first, second] = await Promise.all([
      runPlatformMigrations(pool),
      runPlatformMigrations(pool),
    ]);
    assert.equal(first.current, MIGRATION_NAMES.length);
    assert.equal(second.current, MIGRATION_NAMES.length);
    assert.deepEqual([...first.applied, ...second.applied].sort(), [...MIGRATION_NAMES].sort());

    const versions = await pool.query('SELECT version FROM platform_schema_migrations ORDER BY version');
    assert.deepEqual(versions.rows.map(({ version: name }) => name), MIGRATION_NAMES);
    const extension = await pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    assert.equal(extension.rows.length, 1, 'pgvector extension must be available');
    const vector = await pool.query("SELECT '[1,0]'::vector <=> '[0,1]'::vector AS distance");
    assert.equal(Number(vector.rows[0].distance), 1);

    const registered = await registerWithPassword(pool, {
      email: 'pg-integration@example.test',
      password: 'CI PostgreSQL integration password',
      displayName: 'PostgreSQL integration',
    }, { secret: AUTH_SECRET });
    const user = await getCurrentUser(pool, registered.accessToken, { secret: AUTH_SECRET });
    assert.equal(user.email, 'pg-integration@example.test');
    assert.equal(user.role, 'listener');

    const rotated = await rotateRefreshToken(pool, registered.refreshToken, { secret: AUTH_SECRET });
    assert.notEqual(rotated.refreshToken, registered.refreshToken);
    await assert.rejects(
      rotateRefreshToken(pool, registered.refreshToken, { secret: AUTH_SECRET }),
      (error) => error?.code === 'refresh_reuse',
    );

    server = createPlatformServer({ pool, secret: AUTH_SECRET, registrationEnabled: false });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const health = await fetch(`http://127.0.0.1:${address.port}/api/v2/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).migration, MIGRATION_NAMES.at(-1));

    const closedRegistration = await fetch(`http://127.0.0.1:${address.port}/api/v2/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'closed-pg@example.test',
        password: 'Closed PostgreSQL test password',
        displayName: 'Closed registration',
      }),
    });
    assert.equal(closedRegistration.status, 403);
  } finally {
    if (server?.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await pool.end();
  }
});
