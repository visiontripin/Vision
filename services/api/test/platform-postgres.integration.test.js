import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlatformPool } from '../src/platform/postgres.js';
import { runPlatformMigrations } from '../src/platform/migrations.js';
import { registerWithPassword, getCurrentUser, rotateRefreshToken } from '../src/platform/identity.js';
import { createPlaybackSession, ingestPlayEvents, revokePlaybackSession } from '../src/platform/events.js';
import { createPlatformServer } from '../src/platform/server.js';
import { createInMemoryRateLimiter } from '../src/platform/rate-limit.js';

const DATABASE_URL = process.env.PLATFORM_DATABASE_URL;
const AUTH_SECRET = process.env.PLATFORM_AUTH_SECRET || 'ci-postgres-integration-secret-32-bytes-min';
const MIGRATIONS_DIR = fileURLToPath(new URL('../src/platform/migrations/', import.meta.url));
const MIGRATION_NAMES = [
  '001_identity_catalog.sql',
  '002_events_recsys.sql',
  '003_radio_voice.sql',
  '004_rights_moderation_audit.sql',
  '005_server_runtime.sql',
  '006_voice_storage.sql',
  '007_tts_cost_ledger.sql',
  '008_playback_sessions.sql',
];

test('platform stack works on PostgreSQL 16 with pgvector', {
  skip: !DATABASE_URL && 'Set PLATFORM_DATABASE_URL to run the real PostgreSQL integration test.',
}, async () => {
  const priorMigrationsDir = await mkdtemp(path.join(tmpdir(), 'vision-pg16-before-008-'));
  const pool = createPlatformPool({ connectionString: DATABASE_URL, max: 4 });
  let server;
  let rateLimiter;
  try {
    const version = await pool.query('SHOW server_version_num');
    assert.ok(Number(version.rows[0].server_version_num) >= 160000, 'PostgreSQL 16 or newer is required.');

    // This job owns a disposable database. Resetting public gives the test a clean
    // migration target and ensures the pgvector extension is installed by our SQL.
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');

    // Apply the known-good 001–007 history with concurrent runners, then seed
    // retries that migration 008 must collapse before creating its unique index.
    const priorVersions = MIGRATION_NAMES.slice(0, -1);
    for (const name of priorVersions) {
      await copyFile(path.join(MIGRATIONS_DIR, name), path.join(priorMigrationsDir, name));
    }
    const [first, second] = await Promise.all([
      runPlatformMigrations(pool, { directory: priorMigrationsDir }),
      runPlatformMigrations(pool, { directory: priorMigrationsDir }),
    ]);
    assert.equal(first.current, priorVersions.length);
    assert.equal(second.current, priorVersions.length);
    assert.deepEqual([...first.applied, ...second.applied].sort(), [...priorVersions].sort());

    const historicalSessionId = '10000000-0000-4000-8000-000000000001';
    const firstHistoricalMilestoneId = '20000000-0000-4000-8000-000000000001';
    await pool.query(`
      INSERT INTO play_events (event_id, session_id, kind, source, occurred_at, received_at) VALUES
        ($1, $3, 'play_30s', 'wave', '2026-01-01T00:00:30Z', '2026-01-01T00:00:31Z'),
        ($2, $3, 'play_30s', 'wave', '2026-01-01T00:00:30Z', '2026-01-01T00:00:32Z'),
        ('20000000-0000-4000-8000-000000000003', $3, 'start', 'wave', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `, [firstHistoricalMilestoneId, '20000000-0000-4000-8000-000000000002', historicalSessionId]);

    const upgrade = await runPlatformMigrations(pool);
    assert.deepEqual(upgrade.applied, ['008_playback_sessions.sql']);
    assert.equal(upgrade.current, MIGRATION_NAMES.length);
    const [rerunA, rerunB] = await Promise.all([runPlatformMigrations(pool), runPlatformMigrations(pool)]);
    assert.deepEqual(rerunA.applied, []);
    assert.deepEqual(rerunB.applied, []);
    assert.equal(rerunA.current, MIGRATION_NAMES.length);
    assert.equal(rerunB.current, MIGRATION_NAMES.length);

    const versions = await pool.query('SELECT version FROM platform_schema_migrations ORDER BY version');
    assert.deepEqual(versions.rows.map(({ version: name }) => name), MIGRATION_NAMES);
    const extension = await pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    assert.equal(extension.rows.length, 1, 'pgvector extension must be available');
    const vector = await pool.query("SELECT '[1,0]'::vector <=> '[0,1]'::vector AS distance");
    assert.equal(Number(vector.rows[0].distance), 1);

    const historicalMilestones = await pool.query(`
      SELECT event_id FROM play_events WHERE session_id = $1 AND kind = 'play_30s'
    `, [historicalSessionId]);
    assert.deepEqual(historicalMilestones.rows, [{ event_id: firstHistoricalMilestoneId }]);
    await assert.rejects(pool.query(`
      INSERT INTO play_events (event_id, session_id, kind, source, occurred_at)
      VALUES ('20000000-0000-4000-8000-000000000004', $1, 'play_30s', 'wave', now())
    `, [historicalSessionId]), (error) => error?.code === '23505');

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

    const track = await pool.query(`
      INSERT INTO tracks (owner_id, title, artist_display, duration_ms, rights_confirmed_at, rights_offer_version)
      VALUES ($1, 'PG16 playback fixture', 'Integration artist', 120000, now(), 'ci-test-v1')
      RETURNING id
    `, [user.id]);
    await pool.query(`
      INSERT INTO moderation_queue (track_id, reason, status, decision, decided_at)
      VALUES ($1, 'PG16 integration fixture', 'approved', 'approve', now())
    `, [track.rows[0].id]);
    await pool.query(`
      UPDATE tracks SET status = 'published', visibility = 'public', published_at = now() WHERE id = $1
    `, [track.rows[0].id]);

    const playback = await createPlaybackSession(pool, user.id, track.rows[0].id, {
      secret: AUTH_SECRET,
      nowMs: Date.now() - 60_000,
    });
    const milestone = () => ({
      eventId: randomUUID(),
      trackId: playback.trackId,
      sessionId: playback.sessionId,
      playbackToken: playback.playbackToken,
      kind: 'play_30s',
      positionMs: 30_000,
      durationMs: 120_000,
      source: 'wave',
      device: 'web',
      occurredAt: new Date().toISOString(),
    });
    assert.deepEqual(
      await ingestPlayEvents(pool, user.id, { events: [milestone(), milestone()] }, { secret: AUTH_SECRET }),
      { accepted: 1, duplicates: 1 },
      'PostgreSQL unique index must count at most one play_30s per persisted playback session',
    );
    assert.equal(await revokePlaybackSession(pool, randomUUID(), playback.sessionId), false);
    assert.equal(await revokePlaybackSession(pool, user.id, playback.sessionId), true);
    await assert.rejects(
      ingestPlayEvents(pool, user.id, { events: [milestone()] }, { secret: AUTH_SECRET }),
      (error) => error?.code === 'invalid_playback_session',
      'a revoked PostgreSQL playback session must reject new events',
    );

    rateLimiter = createInMemoryRateLimiter({ secret: AUTH_SECRET });
    server = createPlatformServer({ pool, secret: AUTH_SECRET, registrationEnabled: false, rateLimiter });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const health = await fetch(`http://127.0.0.1:${address.port}/api/v2/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.schemaReady, true);
    assert.equal(healthBody.migration, MIGRATION_NAMES.at(-1));
    assert.equal(healthBody.requiredMigration, MIGRATION_NAMES.at(-1));

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
    await rateLimiter?.close();
    await pool.end();
    await rm(priorMigrationsDir, { recursive: true, force: true });
  }
});
