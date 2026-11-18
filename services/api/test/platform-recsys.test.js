import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { fileURLToPath } from 'node:url';
import { runPlatformMigrations } from '../src/platform/migrations.js';
import {
  evaluateRecommendationFixtures,
  getRecommendations,
  rankRecommendationCandidates,
} from '../src/platform/recsys.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/platform/migrations/', import.meta.url));
let database;
let pool;
let userId;
let ambientTrack;
let jazzTrack;

async function publicTrack({ genre, mood = [], title }) {
  const owner = await pool.query(`
    INSERT INTO users (email, display_name, primary_role)
    VALUES ($1, $2, 'artist') RETURNING id
  `, [`recsys-${title}@example.test`, title]);
  const track = await pool.query(`
    INSERT INTO tracks (owner_id, title, artist_display, genre, mood, rights_confirmed_at, rights_offer_version)
    VALUES ($1, $2, $3, $4, $5, now(), 'recsys-test-v1') RETURNING id
  `, [owner.rows[0].id, title, `Artist ${title}`, genre, mood]);
  const trackId = track.rows[0].id;
  await pool.query(`
    INSERT INTO moderation_queue (track_id, reason, status, decision, decided_at)
    VALUES ($1, 'accepted fixture', 'approved', 'approve', now())
  `, [trackId]);
  await pool.query(`UPDATE tracks SET status = 'published', visibility = 'public', published_at = now() WHERE id = $1`, [trackId]);
  return trackId;
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
  const user = await pool.query("INSERT INTO users (email, display_name) VALUES ('recommendations@example.test', 'Recommendations') RETURNING id");
  userId = user.rows[0].id;
  ambientTrack = await publicTrack({ genre: 'ambient', mood: ['calm', 'night'], title: 'Night Field' });
  jazzTrack = await publicTrack({ genre: 'jazz', mood: ['warm'], title: 'Blue Hour' });
  await pool.query(`
    INSERT INTO play_events (event_id, user_id, track_id, session_id, kind, position_ms, duration_ms, source, occurred_at)
    VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), 'finish', 180000, 180000, 'wave', now())
  `, [userId, ambientTrack]);
});

after(async () => { if (database) await database.close(); });

describe('deterministic recommendations and offline evaluation', () => {
  test('ranking is stable, responds to taste and diversifies repeated artists', () => {
    const nowMs = Date.UTC(2026, 10, 12);
    const candidates = [
      { id: 'track-a', artistId: 'artist-a', genre: 'ambient', mood: ['calm'], publishedAt: new Date(nowMs), plays: 10 },
      { id: 'track-b', artistId: 'artist-a', genre: 'ambient', mood: ['calm'], publishedAt: new Date(nowMs), plays: 5 },
      { id: 'track-c', artistId: 'artist-b', genre: 'jazz', mood: ['warm'], publishedAt: new Date(nowMs), plays: 5 },
      { id: 'track-d', artistId: 'artist-c', genre: 'ambient', mood: ['night'], publishedAt: new Date(nowMs), plays: 5 },
    ];
    const history = [
      { trackId: 'history-a', kind: 'finish', genre: 'ambient', mood: ['calm'], artistId: 'artist-a', occurredAt: new Date(nowMs) },
      { trackId: 'track-c', kind: 'skip_early', genre: 'jazz', mood: ['warm'], artistId: 'artist-b', occurredAt: new Date(nowMs) },
    ];
    const first = rankRecommendationCandidates({ userId: 'user-1', candidates, history, limit: 4, nowMs });
    const second = rankRecommendationCandidates({ userId: 'user-1', candidates, history, limit: 4, nowMs });
    assert.deepEqual(first.map(({ id }) => id), second.map(({ id }) => id));
    assert.ok(first[0].id === 'track-a' || first[0].id === 'track-d');
    assert.equal(first.some(({ id }) => id === 'track-c'), false, 'recently skipped tracks are suppressed');
    assert.ok(first.findIndex(({ id }) => id === 'track-a') < first.findIndex(({ id }) => id === 'track-b'),
      'artist diversity penalty moves an immediately repeated artist down');
  });

  test('offline fixture evaluator produces bounded recall, nDCG and catalog coverage', () => {
    const metrics = evaluateRecommendationFixtures([{
      userId: 'offline-user',
      relevantIds: ['one', 'two'],
      history: [{ trackId: 'history-track', kind: 'finish', genre: 'ambient', mood: [], artistId: 'a', occurredAt: new Date('2026-01-01') }],
      candidates: [
        { id: 'one', artistId: 'a', genre: 'ambient', mood: [], publishedAt: new Date('2026-01-01'), plays: 1 },
        { id: 'two', artistId: 'b', genre: 'ambient', mood: [], publishedAt: new Date('2026-01-01'), plays: 1 },
        { id: 'three', artistId: 'c', genre: 'jazz', mood: [], publishedAt: new Date('2026-01-01'), plays: 1 },
      ],
    }], { k: 2, nowMs: Date.UTC(2026, 0, 2) });
    assert.equal(metrics.recallAtK, 1);
    assert.equal(metrics.ndcgAtK, 1);
    assert.equal(metrics.catalogCoverage, 2 / 3);
    assert.equal(metrics.fixtureCount, 1);
  });

  test('database retrieval returns only eligible public tracks and supports explicit filters', async () => {
    const result = await getRecommendations(pool, userId, new URLSearchParams('genre=ambient&mood=calm&limit=10'));
    assert.equal(result.modelVersion, 'deterministic-v1');
    assert.deepEqual(result.items.map(({ id }) => id), [ambientTrack]);
    assert.equal('artistId' in result.items[0], false);
    assert.equal('vectorScore' in result.items[0], false);

    await assert.rejects(getRecommendations(pool, userId, new URLSearchParams('limit=500')),
      (error) => error.code === 'invalid_input' && error.status === 400);
    const moodMismatch = await getRecommendations(pool, userId, new URLSearchParams('mood=night'));
    assert.deepEqual(moodMismatch.items.map(({ id }) => id), [ambientTrack]);
  });
});
