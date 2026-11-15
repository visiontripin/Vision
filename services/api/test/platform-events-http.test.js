import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { createPlatformServer } from '../src/platform/server.js';
import { runPlatformMigrations } from '../src/platform/migrations.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/platform/migrations/', import.meta.url));
const AUTH_SECRET = 'platform-events-http-secret-at-least-32-bytes';
let database;
let pool;

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
});

after(async () => { if (database) await database.close(); });

async function request(base, pathname, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function withServer(callback) {
  const server = createPlatformServer({ pool, secret: AUTH_SECRET, registrationEnabled: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try { await callback(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

describe('events and recommendation HTTP contracts', () => {
  test('auth, deduplication, privacy filters and deterministic retrieval are enforced', async () => {
    await withServer(async (base) => {
      const listener = await request(base, '/api/v2/auth/register', {
        method: 'POST', body: { email: 'events-http-listener@example.test', password: 'events http long test password', displayName: 'Events listener' },
      });
      const artist = await pool.query(`
        INSERT INTO users (email, display_name, primary_role)
        VALUES ('events-http-artist@example.test', 'Events artist', 'artist') RETURNING id
      `);
      const track = await pool.query(`
        INSERT INTO tracks (
          owner_id, title, artist_display, genre, mood, duration_ms, rights_confirmed_at, rights_offer_version
        ) VALUES ($1, 'Approved event track', 'Events artist', 'ambient', ARRAY['calm'], 180000, now(), 'events-http-v1')
        RETURNING id
      `, [artist.rows[0].id]);
      await pool.query(`
        INSERT INTO moderation_queue (track_id, reason, status, decision, decided_at)
        VALUES ($1, 'event route fixture', 'approved', 'approve', now())
      `, [track.rows[0].id]);
      await pool.query(`
        UPDATE tracks SET status = 'published', visibility = 'public', published_at = now() WHERE id = $1
      `, [track.rows[0].id]);
      const event = {
        eventId: '03c2e29b-7c83-4f6e-a1d6-3a8a7d5f9df0',
        trackId: track.rows[0].id,
        sessionId: '84ab7acd-d23b-4f86-a8d8-57192c93a571',
        kind: 'finish',
        positionMs: 180000,
        durationMs: 180000,
        source: 'wave',
        device: 'web',
        occurredAt: new Date().toISOString(),
      };
      const missingAuth = await request(base, '/api/v2/events', { method: 'POST', body: { events: [event] } });
      assert.equal(missingAuth.response.status, 401);
      const accepted = await request(base, '/api/v2/events', {
        method: 'POST', token: listener.body.accessToken, body: { events: [event] },
      });
      assert.equal(accepted.response.status, 202);
      assert.deepEqual(accepted.body, { accepted: 1, duplicates: 0 });
      const duplicate = await request(base, '/api/v2/events', {
        method: 'POST', token: listener.body.accessToken, body: { events: [event] },
      });
      assert.deepEqual(duplicate.body, { accepted: 0, duplicates: 1 });

      const recommendations = await request(base, '/api/v2/recommendations?genre=ambient&limit=10', {
        token: listener.body.accessToken,
      });
      assert.equal(recommendations.response.status, 200);
      assert.equal(recommendations.body.modelVersion, 'deterministic-v1');
      assert.deepEqual(recommendations.body.items.map(({ id }) => id), [track.rows[0].id]);
      const privateRecommendation = await request(base, '/api/v2/recommendations');
      assert.equal(privateRecommendation.response.status, 401);

      const privateTrack = await pool.query(`
        INSERT INTO tracks (owner_id, title, artist_display, genre, rights_confirmed_at, rights_offer_version)
        VALUES ($1, 'Private must not leak', 'Events artist', 'ambient', now(), 'events-http-v1') RETURNING id
      `, [artist.rows[0].id]);
      const invalidBatch = await request(base, '/api/v2/events', {
        method: 'POST', token: listener.body.accessToken,
        body: { events: [event, { ...event, eventId: 'e43724aa-75ab-44e5-9b7f-8fe900ea35cb', trackId: privateTrack.rows[0].id }] },
      });
      assert.equal(invalidBatch.response.status, 404);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM play_events WHERE user_id = $1', [listener.body.user.id])).rows[0].count, 1,
        'a mixed private/public batch must be rejected atomically');
      const unsupported = await request(base, '/api/v2/events', {
        method: 'POST', token: listener.body.accessToken, body: { events: [{ ...event, fake: true }] },
      });
      assert.equal(unsupported.response.status, 400);
    });
  });
});
