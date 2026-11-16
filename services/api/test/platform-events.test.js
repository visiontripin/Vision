import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { fileURLToPath } from 'node:url';
import { runPlatformMigrations } from '../src/platform/migrations.js';
import { createPlaybackSession, ingestPlayEvents, revokePlaybackSession } from '../src/platform/events.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/platform/migrations/', import.meta.url));
const AUTH_SECRET = 'platform-events-unit-secret-at-least-32-bytes';
let database;
let pool;
let userId;
let otherUserId;
let publicTrackId;
let otherPublicTrackId;
let privateTrackId;

async function makeTrack(isPublic) {
  const inserted = await pool.query(`
    INSERT INTO tracks (owner_id, title, artist_display, duration_ms, rights_confirmed_at, rights_offer_version)
    VALUES ($1, 'Event fixture', 'Event artist', $2, $3, $4) RETURNING id
  `, [userId, isPublic ? 180_000 : null, isPublic ? new Date() : null, isPublic ? 'event-offer-v1' : null]);
  const trackId = inserted.rows[0].id;
  if (isPublic) {
    await pool.query(`
      INSERT INTO moderation_queue (track_id, reason, status, decision, decided_at)
      VALUES ($1, 'approved fixture', 'approved', 'approve', now())
    `, [trackId]);
    await pool.query(`UPDATE tracks SET status = 'published', visibility = 'public', published_at = now() WHERE id = $1`, [trackId]);
  }
  return trackId;
}

function playbackEvent(capability, patch = {}) {
  return {
    eventId: randomUUID(),
    trackId: capability.trackId,
    sessionId: capability.sessionId,
    playbackToken: capability.playbackToken,
    kind: 'start',
    positionMs: 0,
    durationMs: 180_000,
    source: 'wave',
    device: 'web',
    occurredAt: new Date().toISOString(),
    ...patch,
  };
}

function errorIs(code, status) {
  return (error) => error.code === code && error.status === status;
}

async function issuePlaybackSession({
  user = userId,
  track = publicTrackId,
  nowMs = Date.now(),
} = {}) {
  return createPlaybackSession(pool, user, track, { secret: AUTH_SECRET, nowMs });
}

before(async () => {
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
  const user = await pool.query("INSERT INTO users (email, display_name) VALUES ('events@example.test', 'Events user') RETURNING id");
  const otherUser = await pool.query("INSERT INTO users (email, display_name) VALUES ('events-other@example.test', 'Another user') RETURNING id");
  userId = user.rows[0].id;
  otherUserId = otherUser.rows[0].id;
  publicTrackId = await makeTrack(true);
  otherPublicTrackId = await makeTrack(true);
  privateTrackId = await makeTrack(false);
});

after(async () => { if (database) await database.close(); });

describe('privacy-minimal play event ingestion', () => {
  test('issues a short-lived capability only for an approved public track', async () => {
    const nowMs = Date.now();
    const capability = await issuePlaybackSession({ nowMs });
    assert.equal(capability.trackId, publicTrackId);
    assert.match(capability.sessionId, /^[0-9a-f-]{36}$/i);
    assert.match(capability.playbackToken, /^p1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(capability.expiresInSeconds, 3_600);
    assert.equal(Date.parse(capability.expiresAt), (Math.floor(nowMs / 1_000) + 3_600) * 1_000);
    const persisted = await pool.query(`
      SELECT user_id, track_id, issued_at, expires_at, revoked_at
      FROM playback_sessions WHERE id = $1
    `, [capability.sessionId]);
    assert.equal(persisted.rows.length, 1);
    assert.equal(persisted.rows[0].user_id, userId);
    assert.equal(persisted.rows[0].track_id, publicTrackId);
    assert.equal(new Date(persisted.rows[0].expires_at).toISOString(), capability.expiresAt);
    assert.equal(persisted.rows[0].revoked_at, null);
    await assert.rejects(issuePlaybackSession({ track: privateTrackId }), errorIs('not_found', 404));
    await assert.rejects(issuePlaybackSession({ track: randomUUID() }), errorIs('not_found', 404));
  });

  test('accepts deduplicated batches only for approved public tracks', async () => {
    const capability = await issuePlaybackSession({ nowMs: Date.now() - 60_000 });
    const first = playbackEvent(capability, { kind: 'play_30s', positionMs: 30_000 });
    const replayedMilestone = playbackEvent(capability, { kind: 'play_30s', positionMs: 30_000 });
    const second = playbackEvent(capability, { kind: 'finish', positionMs: 180_000 });
    const result = await ingestPlayEvents(pool, userId, { events: [first, second, replayedMilestone] }, { secret: AUTH_SECRET });
    assert.deepEqual(result, { accepted: 2, duplicates: 1 });
    assert.deepEqual(await ingestPlayEvents(pool, userId, { events: [first] }, { secret: AUTH_SECRET }), { accepted: 0, duplicates: 1 });
    const rows = await pool.query(`
      SELECT kind, source, device, ip_hash FROM play_events WHERE user_id = $1 ORDER BY kind
    `, [userId]);
    assert.deepEqual(rows.rows, [
      { kind: 'finish', source: 'wave', device: 'web', ip_hash: null },
      { kind: 'play_30s', source: 'wave', device: 'web', ip_hash: null },
    ]);
  });

  test('persisted sessions can be revoked only by their owner and then reject events', async () => {
    const capability = await issuePlaybackSession();
    assert.equal(await revokePlaybackSession(pool, otherUserId, capability.sessionId), false);
    assert.equal(await revokePlaybackSession(pool, userId, capability.sessionId), true);
    assert.equal(await revokePlaybackSession(pool, userId, capability.sessionId), true, 'revocation is idempotent');
    await assert.rejects(
      ingestPlayEvents(pool, userId, { events: [playbackEvent(capability)] }, { secret: AUTH_SECRET }),
      errorIs('invalid_playback_session', 401),
    );
  });

  test('does not accept early or backdated play_30s events', async () => {
    const capability = await issuePlaybackSession();
    const premature = playbackEvent(capability, { kind: 'play_30s', positionMs: 30_000 });
    await assert.rejects(
      ingestPlayEvents(pool, userId, { events: [premature] }, { secret: AUTH_SECRET }),
      errorIs('invalid_input', 400),
    );

    const issuedAtMs = Date.now() - 60_000;
    const delayedCapability = await issuePlaybackSession({ nowMs: issuedAtMs });
    const tokenIssuedAtMs = Math.floor(issuedAtMs / 1_000) * 1_000;
    const backdated = playbackEvent(delayedCapability, {
      kind: 'play_30s', positionMs: 30_000,
      occurredAt: new Date(tokenIssuedAtMs + 10_000).toISOString(),
    });
    await assert.rejects(
      ingestPlayEvents(pool, userId, { events: [backdated] }, {
        secret: AUTH_SECRET, nowMs: tokenIssuedAtMs + 40_000,
      }),
      errorIs('invalid_input', 400),
    );
  });

  test('rejects tampered, expired, or user/track/session-mismatched capabilities without writes', async () => {
    const valid = await issuePlaybackSession();
    const before = await pool.query('SELECT count(*)::int AS count FROM play_events WHERE user_id = $1', [userId]);
    const [version, payload, signature] = valid.playbackToken.split('.');
    const changedSignature = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    const attempts = [
      [userId, playbackEvent(valid, { playbackToken: `${version}.${payload}.${changedSignature}` })],
      [userId, playbackEvent(valid, { sessionId: randomUUID() })],
      [userId, playbackEvent(valid, { trackId: otherPublicTrackId })],
      [otherUserId, playbackEvent(valid)],
    ];
    for (const [actorId, item] of attempts) {
      await assert.rejects(
        ingestPlayEvents(pool, actorId, { events: [item] }, { secret: AUTH_SECRET }),
        errorIs('invalid_playback_session', 401),
      );
    }

    const expired = await issuePlaybackSession({ nowMs: Date.now() - 3_601_000 });
    await assert.rejects(
      ingestPlayEvents(pool, userId, { events: [playbackEvent(expired)] }, { secret: AUTH_SECRET }),
      errorIs('invalid_playback_session', 401),
    );
    const after = await pool.query('SELECT count(*)::int AS count FROM play_events WHERE user_id = $1', [userId]);
    assert.equal(after.rows[0].count, before.rows[0].count, 'invalid capabilities must not persist events');
  });

  test('client-reported durations cannot manufacture impossible play_30s events', async () => {
    const capability = await issuePlaybackSession({ nowMs: Date.now() - 60_000 });
    const before = await pool.query('SELECT count(*)::int AS count FROM play_events WHERE user_id = $1', [userId]);
    const fabricated = playbackEvent(capability, {
      kind: 'play_30s', positionMs: 30_000, durationMs: 1_000,
    });
    await assert.rejects(
      ingestPlayEvents(pool, userId, { events: [fabricated] }, { secret: AUTH_SECRET }),
      errorIs('invalid_input', 400),
    );

    const overrun = playbackEvent(capability, {
      kind: 'finish', positionMs: 183_000, durationMs: 180_000,
    });
    await assert.rejects(
      ingestPlayEvents(pool, userId, { events: [overrun] }, { secret: AUTH_SECRET }),
      errorIs('invalid_input', 400),
    );
    const after = await pool.query('SELECT count(*)::int AS count FROM play_events WHERE user_id = $1', [userId]);
    assert.equal(after.rows[0].count, before.rows[0].count, 'impossible event payloads must not be persisted');
  });

  test('private tracks and malformed batches fail closed without partial writes', async () => {
    const capability = await issuePlaybackSession();
    const privateEvent = playbackEvent(capability, { trackId: privateTrackId });
    await assert.rejects(ingestPlayEvents(pool, userId, { events: [playbackEvent(capability), privateEvent] }, { secret: AUTH_SECRET }),
      errorIs('not_found', 404));
    const count = await pool.query('SELECT count(*)::int AS count FROM play_events WHERE user_id = $1', [userId]);
    assert.equal(count.rows[0].count, 2);

    await assert.rejects(ingestPlayEvents(pool, userId, { events: [playbackEvent(capability, { extraIp: '198.51.100.10' })] }, { secret: AUTH_SECRET }),
      errorIs('invalid_input', 400));
    await assert.rejects(ingestPlayEvents(pool, userId, { events: [playbackEvent(capability, { kind: 'play_30s', positionMs: 10_000 })] }, { secret: AUTH_SECRET }),
      errorIs('invalid_input', 400));
    await assert.rejects(ingestPlayEvents(pool, userId, { events: [playbackEvent(capability, { occurredAt: new Date(Date.now() - 8 * 86400_000).toISOString() })] }, { secret: AUTH_SECRET }),
      errorIs('invalid_input', 400));
    await assert.rejects(ingestPlayEvents(pool, userId, { events: [] }, { secret: AUTH_SECRET }),
      errorIs('invalid_input', 400));
  });
});
