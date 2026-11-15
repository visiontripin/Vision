import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { createPlatformServer } from '../src/platform/server.js';
import { runPlatformMigrations } from '../src/platform/migrations.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/platform/migrations/', import.meta.url));
const AUTH_SECRET = 'platform-radio-http-secret-at-least-32-bytes';
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
  const storage = {
    async createDownloadUrl({ key, contentType, expiresInSeconds }) {
      return `https://radio-storage.test/${encodeURIComponent(key)}?type=${encodeURIComponent(contentType)}&ttl=${expiresInSeconds}`;
    },
  };
  const server = createPlatformServer({ pool, secret: AUTH_SECRET, registrationEnabled: true, storage });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try { await callback(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

async function register(base, email, displayName) {
  return request(base, '/api/v2/auth/register', {
    method: 'POST',
    body: { email, password: `Long test password for ${displayName}`, displayName },
  });
}

describe('radio HTTP contracts and owner permissions', () => {
  test('sessions, schedule, skip and TTS fail-closed states are exposed at the API boundary', async () => {
    await withServer(async (base) => {
      const listener = await register(base, 'radio-http-listener@example.test', 'Radio HTTP listener');
      const stranger = await register(base, 'radio-http-stranger@example.test', 'Radio HTTP stranger');
      const moderator = await register(base, 'radio-http-moderator@example.test', 'Radio HTTP moderator');
      assert.equal(listener.response.status, 201);
      assert.equal(stranger.response.status, 201);
      assert.equal(moderator.response.status, 201);
      await pool.query("UPDATE users SET primary_role = 'moderator' WHERE id = $1", [moderator.body.user.id]);

      const artist = await pool.query(`
        INSERT INTO users (email, display_name, primary_role)
        VALUES ('radio-http-artist@example.test', 'Radio HTTP artist', 'artist') RETURNING id
      `);
      const track = await pool.query(`
        INSERT INTO tracks (
          owner_id, title, artist_display, genre, mood, duration_ms,
          rights_confirmed_at, rights_offer_version
        ) VALUES ($1, 'HTTP radio fixture', 'Radio HTTP artist', 'ambient', ARRAY['calm'],
          180000, now(), 'radio-http-v1') RETURNING id
      `, [artist.rows[0].id]);
      await pool.query(`
        INSERT INTO moderation_queue (track_id, reason, status, decision, decided_at)
        VALUES ($1, 'http radio approval', 'approved', 'approve', now())
      `, [track.rows[0].id]);
      await pool.query(`
        UPDATE tracks SET status = 'published', visibility = 'public', published_at = now() WHERE id = $1
      `, [track.rows[0].id]);
      await pool.query(`
        INSERT INTO media_objects (track_id, object_kind, bucket_name, object_key, sha256, size_bytes, lifecycle_state, content_type)
        VALUES ($1, 'original', 'vision-private-media', $2, repeat('c', 64), 1024, 'ready', 'audio/mpeg')
      `, [track.rows[0].id, `media/${artist.rows[0].id}/${track.rows[0].id}/0c6d94b1-70ba-4fc2-9762-9efb99a55177`]);
      const script = await pool.query(`
        INSERT INTO radio_scripts (kind, template, variables, active)
        VALUES ('host', 'Now playing.', '{}'::jsonb, true) RETURNING id
      `);

      const wrongMethod = await request(base, '/api/v2/radio/session', { token: listener.body.accessToken });
      assert.equal(wrongMethod.response.status, 405);
      const started = await request(base, '/api/v2/radio/session', {
        method: 'POST', token: listener.body.accessToken,
        body: { mood: 'calm', genre: 'ambient' },
      });
      assert.equal(started.response.status, 201);
      assert.equal(started.body.schedulerPolicy, 'music-only-v1');
      assert.equal(started.body.schedule.items.length, 1);
      assert.match(started.body.schedule.items[0].url, /^https:\/\/radio-storage\.test\//);

      const wrongOwner = await request(base, `/api/v2/radio/${started.body.id}/next`, { token: stranger.body.accessToken });
      assert.equal(wrongOwner.response.status, 404);
      const badAhead = await request(base, `/api/v2/radio/${started.body.id}/next?ahead=30`, { token: listener.body.accessToken });
      assert.equal(badAhead.response.status, 400);
      const skip = await request(base, `/api/v2/radio/${started.body.id}/skip`, {
        method: 'POST', token: listener.body.accessToken,
        body: { segmentId: started.body.schedule.items[0].id },
      });
      assert.equal(skip.response.status, 200);
      assert.equal(skip.body.feedback.reaction, 'skip');
      assert.equal(skip.body.schedule.items.length, 0);
      const strangerFeedback = await request(base, `/api/v2/radio/${started.body.id}/feedback`, {
        method: 'POST', token: stranger.body.accessToken,
        body: { segmentId: started.body.schedule.items[0].id, reaction: 'like' },
      });
      assert.equal(strangerFeedback.response.status, 404);

      const forbiddenVoice = await request(base, '/api/v2/voice/render', {
        method: 'POST', token: listener.body.accessToken, body: { scriptId: script.rows[0].id, voice: 'unconfigured' },
      });
      assert.equal(forbiddenVoice.response.status, 403);
      const unconfiguredVoice = await request(base, '/api/v2/voice/render', {
        method: 'POST', token: moderator.body.accessToken, body: { scriptId: script.rows[0].id, voice: 'unconfigured' },
      });
      assert.equal(unconfiguredVoice.response.status, 503);
      assert.equal(unconfiguredVoice.body.error.code, 'tts_unconfigured');
    });
  });
});
