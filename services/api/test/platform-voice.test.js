import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { fileURLToPath } from 'node:url';
import { runPlatformMigrations } from '../src/platform/migrations.js';
import { renderRadioScript, UnconfiguredTtsProvider } from '../src/platform/voice.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/platform/migrations/', import.meta.url));
let database;
let pool;
let moderator;
let listener;
let scriptId;
let synthesisCount = 0;
let failNextPut = false;
const stored = new Map();
const storage = {
  makeMediaKey({ ownerId, trackId, objectId }) { return `media/${ownerId}/${trackId}/${objectId}`; },
  async putPrivateObject({ key, body }) {
    if (failNextPut) {
      failNextPut = false;
      throw new Error('test storage write failed');
    }
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    stored.set(key, Buffer.concat(chunks));
  },
  async createDownloadUrl({ key, contentType, expiresInSeconds }) {
    assert.ok(stored.has(key));
    return `https://private-voice.test/${encodeURIComponent(key)}?type=${encodeURIComponent(contentType)}&ttl=${expiresInSeconds}`;
  },
};
const fakeProvider = {
  name: 'test-fake',
  available: true,
  async supportsVoice(voice) { return ['fake-neutral', 'fake-failure'].includes(voice); },
  async synthesize({ text, voice, params }) {
    synthesisCount += 1;
    assert.equal(text, 'Now playing Test Artist.');
    assert.ok(['fake-neutral', 'fake-failure'].includes(voice));
    assert.deepEqual(params, { tone: 'neutral' });
    return { audio: Readable.from(Buffer.from('test only fake audio bytes')), contentType: 'audio/wav', durationMs: 4_000, costMicrounits: 0 };
  },
};

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
  moderator = { id: (await pool.query("INSERT INTO users (email, display_name, primary_role) VALUES ('voice-mod@example.test', 'Voice moderator', 'moderator') RETURNING id")).rows[0].id, role: 'moderator' };
  listener = { id: (await pool.query("INSERT INTO users (email, display_name) VALUES ('voice-listener@example.test', 'Voice listener') RETURNING id")).rows[0].id, role: 'listener' };
  scriptId = (await pool.query(`
    INSERT INTO radio_scripts (kind, template, variables, tone, active)
    VALUES ('host', 'Now playing {{artist}}.', '{"artist":"Test Artist"}'::jsonb, 'neutral', true)
    RETURNING id
  `)).rows[0].id;
});

after(async () => { if (database) await database.close(); });

describe('provider-neutral TTS cache and cost accounting', () => {
  test('unconfigured provider fails closed and only moderators may invoke configured rendering', async () => {
    await assert.rejects(renderRadioScript(pool, moderator, { scriptId, voice: 'fake-neutral' }, { storage }),
      (error) => error.code === 'tts_unconfigured' && error.status === 503);
    await assert.rejects(renderRadioScript(pool, listener, { scriptId, voice: 'fake-neutral' }, { storage, provider: fakeProvider }),
      (error) => error.code === 'forbidden' && error.status === 403);
  });

  test('active scripts render through the selected adapter and cache private audio/cost once', async () => {
    const result = await renderRadioScript(pool, moderator, { scriptId, voice: 'fake-neutral' }, { storage, provider: fakeProvider });
    assert.equal(result.provider, 'test-fake');
    assert.equal(result.voice, 'fake-neutral');
    assert.equal(result.durationMs, 4_000);
    assert.equal(result.costMicrounits, '0');
    assert.equal(result.cacheHit, false);
    assert.match(result.url, /^https:\/\/private-voice\.test\//);
    assert.equal('text' in result, false);

    const cached = await renderRadioScript(pool, moderator, { scriptId, voice: 'fake-neutral' }, { storage, provider: fakeProvider });
    assert.equal(cached.cacheHit, true);
    assert.equal(cached.cacheKey, result.cacheKey);
    assert.equal(synthesisCount, 1);
    const rows = await pool.query('SELECT count(*)::int AS count, max(cost_microunits)::text AS cost FROM tts_cache');
    assert.deepEqual(rows.rows[0], { count: 1, cost: '0' });
    const ledger = await pool.query(`
      SELECT outcome, cost_microunits::text AS cost, audio_bytes, duration_ms
      FROM tts_generation_ledger WHERE voice = 'fake-neutral'
    `);
    assert.deepEqual(ledger.rows, [{ outcome: 'stored', cost: '0', audio_bytes: Buffer.byteLength('test only fake audio bytes'), duration_ms: 4_000 }]);
    assert.equal(stored.size, 1);
  });

  test('provider cost remains auditable when private object storage fails after synthesis', async () => {
    failNextPut = true;
    await assert.rejects(renderRadioScript(pool, moderator, { scriptId, voice: 'fake-failure' }, { storage, provider: fakeProvider }),
      /test storage write failed/);
    const ledger = await pool.query(`
      SELECT outcome, cost_microunits::text AS cost, failure_code
      FROM tts_generation_ledger WHERE voice = 'fake-failure'
    `);
    assert.deepEqual(ledger.rows, [{ outcome: 'failed_after_synthesis', cost: '0', failure_code: 'tts_generation_failed' }]);
    assert.equal(synthesisCount, 2);
  });

  test('unsupported voices and arbitrary user text are rejected', async () => {
    await assert.rejects(renderRadioScript(pool, moderator, { scriptId, voice: 'unknown' }, { storage, provider: fakeProvider }),
      (error) => error.code === 'invalid_voice' && error.status === 400);
    await assert.rejects(renderRadioScript(pool, moderator, { scriptId, voice: 'fake-neutral', text: 'user supplied' }, { storage, provider: fakeProvider }),
      (error) => error.code === 'invalid_input' && error.status === 400);
  });
});
