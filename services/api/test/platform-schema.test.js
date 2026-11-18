import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import {
  assertPlatformSchemaCurrent,
  getPlatformSchemaStatus,
  runPlatformMigrations,
} from '../src/platform/migrations.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/platform/migrations/', import.meta.url));
let database;
let migrationResults;
let ownerId;
let quarantinedTrackId;
let sessionId;

async function applySchema() {
  database = new PGlite({ extensions: { vector } });
  await database.waitReady;
  const client = {
    query: async (sql, values) => {
      if (values?.length) return database.query(sql, values);
      const results = await database.exec(sql);
      return results.at(-1) ?? { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client };
  const first = await runPlatformMigrations(pool, { directory: MIGRATIONS_DIR });
  const second = await runPlatformMigrations(pool, { directory: MIGRATIONS_DIR });
  migrationResults = { first, second };
}

before(applySchema);
after(async () => {
  if (database) await database.close();
});

describe('platform PostgreSQL schema (PGlite)', () => {
  test('numbered migrations apply once, including pgvector and its HNSW index', async () => {
    assert.deepEqual(migrationResults.first, {
      applied: [
        '001_identity_catalog.sql',
        '002_events_recsys.sql',
        '003_radio_voice.sql',
        '004_rights_moderation_audit.sql',
        '005_server_runtime.sql',
        '006_voice_storage.sql',
        '007_tts_cost_ledger.sql',
        '008_playback_sessions.sql',
      ],
      current: 8,
    });
    assert.deepEqual(migrationResults.second, { applied: [], current: 8 });

    const tables = await database.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    const tableNames = new Set(tables.rows.map(({ table_name }) => table_name));
    for (const name of [
      'users', 'artist_profiles', 'tracks', 'media_objects', 'moderation_queue',
      'rights_claims', 'platform_audit_events', 'play_events', 'playback_sessions', 'taste_profiles', 'radio_sessions',
      'radio_schedule', 'radio_scripts', 'tts_cache', 'tts_generation_ledger', 'upload_intents', 'platform_outbox',
    ]) assert.ok(tableNames.has(name), `expected migrated table ${name}`);
    const voiceColumns = await database.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'tts_cache' AND column_name IN ('object_key', 'content_type') ORDER BY column_name
    `);
    assert.deepEqual(voiceColumns.rows.map(({ column_name }) => column_name), ['content_type', 'object_key']);

    const extensions = await database.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
    assert.equal(extensions.rows.length, 1);
    const indexes = await database.query(`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'tracks' AND indexname = 'tracks_embedding_hnsw_idx'
    `);
    assert.match(indexes.rows[0].indexdef, /USING hnsw/i);
    const playbackMilestone = await database.query(`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'play_events' AND indexname = 'play_events_play_30s_once_idx'
    `);
    assert.equal(playbackMilestone.rows.length, 1);
    assert.match(playbackMilestone.rows[0].indexdef, /UNIQUE/i);
    assert.match(playbackMilestone.rows[0].indexdef, /play_30s/i);
  });

  test('API startup schema gate refuses databases behind the required migration', async () => {
    const stalePool = {
      async query(sql) {
        if (String(sql).includes('to_regclass')) {
          return { rows: [{ has_migrations: true, has_users: true }] };
        }
        return { rows: [{ version: '007_tts_cost_ledger.sql' }] };
      },
    };
    assert.deepEqual(await getPlatformSchemaStatus(stalePool), {
      migration: '007_tts_cost_ledger.sql', ready: false,
    });
    await assert.rejects(
      assertPlatformSchemaCurrent(stalePool),
      /Platform schema is at 007_tts_cost_ledger\.sql, expected 008_playback_sessions\.sql/,
    );
    assert.equal(await assertPlatformSchemaCurrent(database), '008_playback_sessions.sql');
  });

  test('migration 008 keeps one historical play_30s milestone per session before indexing', async () => {
    const migrationDirectory = await mkdtemp(path.join(tmpdir(), 'vision-platform-upgrade-'));
    const upgradeDb = new PGlite({ extensions: { vector } });
    try {
      await upgradeDb.waitReady;
      const client = {
        query: async (sql, values) => {
          if (values?.length) return upgradeDb.query(sql, values);
          const results = await upgradeDb.exec(sql);
          return results.at(-1) ?? { rows: [] };
        },
        release() {},
      };
      const upgradePool = { connect: async () => client, query: client.query };
      for (const name of (await readdir(MIGRATIONS_DIR)).filter((file) => file < '008_playback_sessions.sql')) {
        await copyFile(path.join(MIGRATIONS_DIR, name), path.join(migrationDirectory, name));
      }
      const beforeUpgrade = await runPlatformMigrations(upgradePool, { directory: migrationDirectory });
      assert.equal(beforeUpgrade.current, 7);

      const session = '10000000-0000-4000-8000-000000000001';
      const firstMilestone = '20000000-0000-4000-8000-000000000001';
      await upgradeDb.query(`
        INSERT INTO play_events (event_id, session_id, kind, source, occurred_at, received_at) VALUES
          ($1, $3, 'play_30s', 'wave', '2026-01-01T00:00:30Z', '2026-01-01T00:00:31Z'),
          ($2, $3, 'play_30s', 'wave', '2026-01-01T00:00:30Z', '2026-01-01T00:00:32Z'),
          ('20000000-0000-4000-8000-000000000003', $3, 'start', 'wave', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      `, [firstMilestone, '20000000-0000-4000-8000-000000000002', session]);

      const afterUpgrade = await runPlatformMigrations(upgradePool, { directory: MIGRATIONS_DIR });
      assert.deepEqual(afterUpgrade.applied, ['008_playback_sessions.sql']);
      const milestones = await upgradeDb.query(`
        SELECT event_id FROM play_events WHERE session_id = $1 AND kind = 'play_30s'
      `, [session]);
      assert.deepEqual(milestones.rows, [{ event_id: firstMilestone }]);
      const unrelated = await upgradeDb.query(`
        SELECT count(*)::integer AS count FROM play_events WHERE session_id = $1 AND kind = 'start'
      `, [session]);
      assert.equal(unrelated.rows[0].count, 1);
    } finally {
      await upgradeDb.close();
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  test('case-insensitive email uniqueness and default-quarantine catalog state hold', async () => {
    const user = await database.query(
      "INSERT INTO users (display_name, email) VALUES ('Platform owner', 'Owner@vision.test') RETURNING id",
    );
    ownerId = user.rows[0].id;
    await assert.rejects(
      database.query("INSERT INTO users (display_name, email) VALUES ('Duplicate', 'owner@VISION.test')"),
      /unique constraint/i,
    );

    const track = await database.query(`
      INSERT INTO tracks (owner_id, title, artist_display)
      VALUES ($1, 'Private draft', 'Test artist')
      RETURNING id, status, visibility
    `, [ownerId]);
    quarantinedTrackId = track.rows[0].id;
    assert.deepEqual(track.rows[0], {
      id: quarantinedTrackId,
      status: 'quarantine',
      visibility: 'private',
    });
  });

  test('a track cannot become published until an approved moderation decision exists', async () => {
    await assert.rejects(
      database.query(`
        INSERT INTO tracks (owner_id, title, artist_display, status, visibility, rights_confirmed_at, rights_offer_version)
        VALUES ($1, 'Bypass attempt', 'Test artist', 'published', 'public', now(), 'test-v1')
      `, [ownerId]),
      /without an approved moderation decision/i,
    );

    await assert.rejects(
      database.query(`
        UPDATE tracks SET status = 'published', visibility = 'public',
          rights_confirmed_at = now(), rights_offer_version = 'test-v1', published_at = now()
        WHERE id = $1
      `, [quarantinedTrackId]),
      /without an approved moderation decision/i,
    );

    await database.query(`
      INSERT INTO moderation_queue (track_id, reason, status, decision, decided_at)
      VALUES ($1, 'manual review', 'approved', 'approved', now())
    `, [quarantinedTrackId]);
    const published = await database.query(`
      UPDATE tracks SET status = 'published', visibility = 'public',
        rights_confirmed_at = now(), rights_offer_version = 'test-v1', published_at = now()
      WHERE id = $1
      RETURNING status, visibility
    `, [quarantinedTrackId]);
    assert.deepEqual(published.rows[0], { status: 'published', visibility: 'public' });

    await database.query(`
      INSERT INTO moderation_queue (track_id, reason, status, created_at)
      VALUES ($1, 'metadata changed', 'pending', now() + interval '1 hour')
    `, [quarantinedTrackId]);
    await database.query("UPDATE tracks SET status = 'in_review', visibility = 'private' WHERE id = $1", [quarantinedTrackId]);
    await assert.rejects(
      database.query(`
        UPDATE tracks SET status = 'published', visibility = 'public', published_at = now()
        WHERE id = $1
      `, [quarantinedTrackId]),
      /without an approved moderation decision/i,
      'an older approval cannot bypass a newer pending moderation decision',
    );
  });

  test('migration 004 safely quarantines legacy tracks and repairs historical moderation rows', async () => {
    const legacyDb = new PGlite({ extensions: { vector } });
    try {
      await legacyDb.waitReady;
      for (const name of [
        '001_identity_catalog.sql',
        '002_events_recsys.sql',
        '003_radio_voice.sql',
      ]) {
        const sql = await readFile(new URL(`../src/platform/migrations/${name}`, import.meta.url), 'utf8');
        await legacyDb.exec(sql);
      }

      const user = await legacyDb.query(
        "INSERT INTO users (display_name, email) VALUES ('Legacy owner', 'legacy-owner@example.test') RETURNING id",
      );
      const owner = user.rows[0].id;
      const legacyTrack = await legacyDb.query(`
        INSERT INTO tracks (owner_id, title, artist_display, rights_confirmed_at)
        VALUES ($1, 'Legacy public track', 'Legacy owner', now()) RETURNING id
      `, [owner]);
      const legacyTrackId = legacyTrack.rows[0].id;
      await legacyDb.query(`
        INSERT INTO moderation_queue (track_id, reason, status, decision, decided_at)
        VALUES ($1, 'legacy approval', 'approved', 'approved', now())
      `, [legacyTrackId]);
      await legacyDb.query(`
        UPDATE tracks SET status = 'published', visibility = 'public', published_at = now() WHERE id = $1
      `, [legacyTrackId]);
      const rightsTrack = await legacyDb.query(`
        INSERT INTO tracks (owner_id, title, artist_display, rights_confirmed_at)
        VALUES ($1, 'Claimed legacy track', 'Legacy owner', now()) RETURNING id
      `, [owner]);
      await legacyDb.query(`
        INSERT INTO moderation_queue (track_id, reason, status, decision, decided_at)
        VALUES ($1, 'legacy approval', 'approved', 'approved', now())
      `, [rightsTrack.rows[0].id]);
      await legacyDb.query(`
        UPDATE tracks SET status = 'published', visibility = 'public', published_at = now() WHERE id = $1
      `, [rightsTrack.rows[0].id]);
      const oldClaim = await legacyDb.query(`
        INSERT INTO rights_claims (track_id, status, resolved_at)
        VALUES ($1, 'counter_notice', now()) RETURNING id
      `, [rightsTrack.rows[0].id]);

      const duplicateTrack = await legacyDb.query(`
        INSERT INTO tracks (owner_id, title, artist_display)
        VALUES ($1, 'Duplicate queue track', 'Legacy owner') RETURNING id
      `, [owner]);
      await legacyDb.query(`
        INSERT INTO moderation_queue (track_id, reason, status, created_at)
        VALUES ($1, 'older pending task', 'pending', now() - interval '1 hour'),
          ($1, 'newer pending task', 'pending', now())
      `, [duplicateTrack.rows[0].id]);

      const migration = await readFile(
        new URL('../src/platform/migrations/004_rights_moderation_audit.sql', import.meta.url),
        'utf8',
      );
      await legacyDb.exec(migration);

      const trackAfterMigration = await legacyDb.query(`
        SELECT status, visibility, rights_confirmed_at, rights_offer_version, published_at
        FROM tracks WHERE id = $1
      `, [legacyTrackId]);
      assert.deepEqual(trackAfterMigration.rows[0], {
        status: 'quarantine', visibility: 'private', rights_confirmed_at: null,
        rights_offer_version: null, published_at: null,
      });
      const queueAfterMigration = await legacyDb.query(`
        SELECT status, decision, decided_at FROM moderation_queue WHERE track_id = $1
      `, [legacyTrackId]);
      assert.deepEqual(queueAfterMigration.rows, [{ status: 'superseded', decision: null, decided_at: null }]);
      await assert.rejects(
        legacyDb.query(`
          UPDATE tracks SET status = 'published', visibility = 'public',
            rights_confirmed_at = now(), rights_offer_version = 'forged-version', published_at = now()
          WHERE id = $1
        `, [legacyTrackId]),
        /without an approved moderation decision/i,
      );
      await legacyDb.query(`
        INSERT INTO moderation_queue (track_id, reason, status, decision, decided_at)
        VALUES ($1, 'new review', 'approved', 'approved', now())
      `, [legacyTrackId]);
      await assert.rejects(
        legacyDb.query(`
          UPDATE tracks SET status = 'published', visibility = 'public',
            rights_confirmed_at = now(), rights_offer_version = '   ', published_at = now()
          WHERE id = $1
        `, [legacyTrackId]),
        /tracks_rights_offer_version_check/i,
      );

      const rightsTrackAfterMigration = await legacyDb.query(`
        SELECT status, visibility, published_at FROM tracks WHERE id = $1
      `, [rightsTrack.rows[0].id]);
      assert.deepEqual(rightsTrackAfterMigration.rows[0], {
        status: 'taken_down', visibility: 'private', published_at: null,
      });
      const rightsQueueAfterMigration = await legacyDb.query(`
        SELECT status, decision, decided_at FROM moderation_queue WHERE track_id = $1
      `, [rightsTrack.rows[0].id]);
      assert.deepEqual(rightsQueueAfterMigration.rows, [{ status: 'superseded', decision: null, decided_at: null }]);
      await legacyDb.query(`
        INSERT INTO moderation_queue (track_id, reason, status, decision, decided_at, created_at)
        VALUES ($1, 'new approval', 'approved', 'approved', now(), now() + interval '1 hour')
      `, [rightsTrack.rows[0].id]);
      await assert.rejects(
        legacyDb.query(`
          UPDATE tracks SET status = 'published', visibility = 'public',
            rights_offer_version = 'valid-v1', published_at = now()
          WHERE id = $1
        `, [rightsTrack.rows[0].id]),
        /unresolved rights claim/i,
      );

      const claimAfterMigration = await legacyDb.query(`
        SELECT status, resolved_at, counter_notice_text, counter_notice_at, counter_notice_by
        FROM rights_claims WHERE id = $1
      `, [oldClaim.rows[0].id]);
      assert.equal(claimAfterMigration.rows[0].status, 'open');
      assert.equal(claimAfterMigration.rows[0].resolved_at, null);
      assert.equal(claimAfterMigration.rows[0].counter_notice_text, null);
      assert.equal(claimAfterMigration.rows[0].counter_notice_at, null);
      assert.equal(claimAfterMigration.rows[0].counter_notice_by, null);

      const duplicateQueue = await legacyDb.query(`
        SELECT reason, status FROM moderation_queue WHERE track_id = $1 ORDER BY created_at
      `, [duplicateTrack.rows[0].id]);
      assert.deepEqual(duplicateQueue.rows.map(({ reason, status }) => [reason, status]), [
        ['older pending task', 'superseded'], ['newer pending task', 'pending'],
      ]);
      const migrationAudit = await legacyDb.query(`
        SELECT action FROM platform_audit_events WHERE target_id IN ($1, $2, $3)
      `, [legacyTrackId, oldClaim.rows[0].id, rightsTrack.rows[0].id]);
      assert.ok(migrationAudit.rows.some(({ action }) => action === 'track.migrated_to_quarantine'));
      assert.ok(migrationAudit.rows.some(({ action }) => action === 'track.migrated_to_takedown'));
      assert.ok(migrationAudit.rows.some(({ action }) => action === 'rights_claim.counter_notice_reopened_by_migration'));

      const runtimeMigration = await readFile(
        new URL('../src/platform/migrations/005_server_runtime.sql', import.meta.url),
        'utf8',
      );
      await legacyDb.exec(runtimeMigration);
      const runtimeSchema = await legacyDb.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('upload_intents', 'platform_outbox')
      `);
      assert.deepEqual(runtimeSchema.rows.map(({ table_name }) => table_name).sort(), ['platform_outbox', 'upload_intents']);
      const quotaColumns = await legacyDb.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'user_quotas' AND column_name IN ('quota_month', 'storage_reserved_bytes')
      `);
      assert.deepEqual(quotaColumns.rows.map(({ column_name }) => column_name).sort(), ['quota_month', 'storage_reserved_bytes']);

      const voiceStorageMigration = await readFile(
        new URL('../src/platform/migrations/006_voice_storage.sql', import.meta.url),
        'utf8',
      );
      await legacyDb.exec(voiceStorageMigration);
      const voiceStorageColumns = await legacyDb.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tts_cache' AND column_name IN ('object_key', 'content_type') ORDER BY column_name
      `);
      assert.deepEqual(voiceStorageColumns.rows.map(({ column_name }) => column_name), ['content_type', 'object_key']);
      const voiceLedgerMigration = await readFile(
        new URL('../src/platform/migrations/007_tts_cost_ledger.sql', import.meta.url),
        'utf8',
      );
      await legacyDb.exec(voiceLedgerMigration);
      const voiceLedger = await legacyDb.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'tts_generation_ledger'
      `);
      assert.equal(voiceLedger.rows.length, 1);
    } finally {
      await legacyDb.close();
    }
  });

  test('event identifiers deduplicate, and radio schedule positions are unique per session', async () => {
    const session = await database.query(
      "INSERT INTO radio_sessions (user_id, mood) VALUES ($1, 'calm') RETURNING id",
      [ownerId],
    );
    sessionId = session.rows[0].id;

    const eventId = 'b6c986ac-11d5-4a5c-9fa4-a71b7329676b';
    const event = `
      INSERT INTO play_events (event_id, user_id, track_id, session_id, kind, position_ms, source, occurred_at)
      VALUES ($1, $2, $3, $4, 'start', 0, 'wave', now())
    `;
    const params = [eventId, ownerId, quarantinedTrackId, sessionId];
    await database.query(event, params);
    await assert.rejects(database.query(event, params), /unique constraint/i);

    const segment = `
      INSERT INTO radio_schedule (session_id, position, segment_type, duration_ms, expires_at)
      VALUES ($1, 0, 'host', 15000, now() + interval '1 hour')
    `;
    await database.query(segment, [sessionId]);
    await assert.rejects(database.query(segment, [sessionId]), /unique constraint/i);
  });
});
