// @ts-check
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { PlatformAuthError } from './auth-crypto.js';
import { requireRole } from './identity.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CACHE_OWNER_ID = '00000000-0000-4000-8000-000000000000';
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const URL_TTL_SECONDS = 60;

/**
 * @typedef {{text: string, voice: string, params: Record<string, string>}} TtsSynthesisRequest
 * @typedef {{audio: Buffer|Uint8Array|string|AsyncIterable<Uint8Array|string>, contentType: string,
 *   durationMs: number, costMicrounits: number}} TtsSynthesisResponse
 * @typedef {{name?: string, available: boolean, supportsVoice(voice: string): Promise<boolean>,
 *   synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResponse>}} TtsProvider
 */

/**
 * Default provider deliberately has no vendor or fallback. Voice generation stays
 * unavailable until the owner selects and configures an approved provider.
 */
export class UnconfiguredTtsProvider {
  name = 'unconfigured';
  available = false;
  /** @param {string} _voice */
  async supportsVoice(_voice) { return false; }
  /** @param {TtsSynthesisRequest} _request @returns {Promise<TtsSynthesisResponse>} */
  async synthesize(_request) {
    throw new PlatformAuthError('tts_unconfigured', 503, 'No TTS provider has been configured.');
  }
}

/** @returns {`${string}-${string}-${string}-${string}-${string}`} */
function stableUuid(hash) {
  const bytes = Buffer.from(hash.slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function collectAudioBytes(audio) {
  if (Buffer.isBuffer(audio) || audio instanceof Uint8Array || typeof audio === 'string') {
    const bytes = Buffer.from(audio);
    if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) {
      throw new PlatformAuthError('tts_output_invalid', 502, 'TTS provider returned an invalid audio size.');
    }
    return bytes;
  }
  if (!audio || typeof audio[Symbol.asyncIterator] !== 'function') {
    throw new PlatformAuthError('tts_output_invalid', 502, 'TTS provider returned invalid audio bytes.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of audio) {
    if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array || typeof chunk === 'string')) {
      throw new PlatformAuthError('tts_output_invalid', 502, 'TTS provider returned invalid audio bytes.');
    }
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_AUDIO_BYTES) {
      if (typeof audio.destroy === 'function') audio.destroy();
      throw new PlatformAuthError('tts_output_invalid', 502, 'TTS provider audio exceeds the size limit.');
    }
    chunks.push(bytes);
  }
  if (!size) throw new PlatformAuthError('tts_output_invalid', 502, 'TTS provider returned an empty audio stream.');
  return Buffer.concat(chunks, size);
}

function renderScript(template, variables) {
  if (typeof template !== 'string' || template.trim().length < 1 || template.length > 10_000) {
    throw new PlatformAuthError('invalid_script', 409, 'Active voice script is invalid.');
  }
  const normalized = variables && typeof variables === 'object' && !Array.isArray(variables) ? variables : {};
  const text = template.replace(/\{\{([A-Za-z0-9_]{1,64})\}\}/g, (_match, key) => {
    const value = normalized[key];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new PlatformAuthError('invalid_script', 409, 'Voice script has an unresolved variable.');
    }
    const result = String(value).trim();
    if (result.length > 500) throw new PlatformAuthError('invalid_script', 409, 'Voice script variable is too long.');
    return result;
  });
  if (!text.trim() || /\{\{[^}]*\}\}/.test(text)) {
    throw new PlatformAuthError('invalid_script', 409, 'Voice script has an unresolved variable.');
  }
  return text.trim();
}

async function publicCachedAudio(row, cacheHit, storage) {
  const url = await storage.createDownloadUrl({
    key: row.object_key,
    contentType: row.content_type,
    expiresInSeconds: URL_TTL_SECONDS,
  });
  return {
    cacheKey: row.hash,
    provider: row.provider,
    voice: row.voice,
    durationMs: row.duration_ms,
    costMicrounits: String(row.cost_microunits ?? 0),
    cacheHit,
    url,
    urlExpiresInSeconds: URL_TTL_SECONDS,
    cacheControl: 'private, no-store',
  };
}

async function saveUsage(client, { attemptId, hash, scriptId, provider, voice, usage, outcome, failureCode = null }) {
  await client.query(`
    INSERT INTO tts_generation_ledger (
      id, cache_hash, script_id, provider, voice, cost_microunits, audio_bytes, duration_ms, outcome, failure_code
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (id) DO NOTHING
  `, [attemptId, hash, scriptId, provider, voice, usage.costMicrounits,
    usage.audioBytes, usage.durationMs, outcome, failureCode]);
}

/**
 * Render only an active, server-owned radio script. Arbitrary user text is not accepted or cached.
 * @param {import('pg').Pool} pool
 * @param {{id: string, role: string}} actor
 * @param {{scriptId?: string, voice?: string}} input
 * @param {{storage?: import('./storage.js').PlatformStorage, provider?: TtsProvider}} [options]
 */
export async function renderRadioScript(pool, actor, input, { storage, provider = new UnconfiguredTtsProvider() } = {}) {
  requireRole(actor, ['moderator', 'admin']);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['scriptId', 'voice'].includes(key))) {
    throw new PlatformAuthError('invalid_input', 400, 'Only scriptId and voice may be provided.');
  }
  if (!provider || provider.available !== true || typeof provider.synthesize !== 'function') {
    throw new PlatformAuthError('tts_unconfigured', 503, 'No TTS provider has been configured.');
  }
  if (!storage) throw new PlatformAuthError('storage_unavailable', 503, 'Private media storage is not configured.');
  if (typeof input?.scriptId !== 'string' || !UUID.test(input.scriptId)) {
    throw new PlatformAuthError('not_found', 404, 'Active voice script not found.');
  }
  if (typeof input?.voice !== 'string' || input.voice.trim().length < 1 || input.voice.trim().length > 100) {
    throw new PlatformAuthError('invalid_input', 400, 'A configured voice id is required.');
  }
  const voice = input.voice.trim();
  if (typeof provider.supportsVoice !== 'function' || !await provider.supportsVoice(voice)) {
    throw new PlatformAuthError('invalid_voice', 400, 'The configured TTS provider does not support this voice id.');
  }
  const scriptResult = await pool.query(`
    SELECT id, template, variables, tone FROM radio_scripts WHERE id = $1 AND active = true
  `, [input.scriptId]);
  const script = scriptResult.rows[0];
  if (!script) throw new PlatformAuthError('not_found', 404, 'Active voice script not found.');
  const text = renderScript(script.template, script.variables);
  const params = { tone: script.tone || 'neutral' };
  const providerName = typeof provider.name === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(provider.name)
    ? provider.name : 'provider';
  const hash = createHash('sha256')
    .update(JSON.stringify({ text, voice, params, provider: providerName }))
    .digest('hex');
  const attemptId = randomUUID();
  let usage = null;

  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [hash]);
    const cached = await client.query(`
      SELECT hash, provider, voice, text, object_key, content_type, duration_ms, cost_microunits
      FROM tts_cache WHERE hash = $1 FOR UPDATE
    `, [hash]);
    if (cached.rows[0]?.object_key) {
      await client.query('COMMIT');
      inTransaction = false;
      return await publicCachedAudio(cached.rows[0], true, storage);
    }

    const generated = await provider.synthesize({ text, voice, params });
    if (Number.isSafeInteger(generated?.costMicrounits) && generated.costMicrounits >= 0) {
      usage = { costMicrounits: String(generated.costMicrounits), audioBytes: null, durationMs: null };
    }
    const audio = await collectAudioBytes(generated?.audio);
    if (usage) usage.audioBytes = audio.length;
    const contentType = generated.contentType;
    if (typeof contentType !== 'string' || !/^audio\/[a-z0-9.+-]{1,64}$/i.test(contentType)) {
      throw new PlatformAuthError('tts_output_invalid', 502, 'TTS provider returned an unsupported audio content type.');
    }
    const durationMs = generated.durationMs;
    const costMicrounits = generated.costMicrounits;
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 10 * 60_000
      || !Number.isSafeInteger(costMicrounits) || costMicrounits < 0) {
      throw new PlatformAuthError('tts_output_invalid', 502, 'TTS provider returned invalid duration or cost metadata.');
    }
    usage.durationMs = durationMs;
    const objectKey = storage.makeMediaKey({
      ownerId: CACHE_OWNER_ID,
      trackId: script.id,
      objectId: stableUuid(hash),
    });
    await storage.putPrivateObject({
      key: objectKey,
      body: Readable.from(audio),
      contentType,
      contentLength: audio.length,
    });
    const saved = await client.query(`
      INSERT INTO tts_cache (hash, provider, voice, text, object_key, content_type, duration_ms, cost_microunits)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (hash) DO UPDATE SET object_key = EXCLUDED.object_key,
        content_type = EXCLUDED.content_type, duration_ms = EXCLUDED.duration_ms,
        cost_microunits = EXCLUDED.cost_microunits
      RETURNING hash, provider, voice, text, object_key, content_type, duration_ms, cost_microunits
    `, [hash, providerName, voice, text, objectKey, contentType, durationMs, costMicrounits]);
    await saveUsage(client, {
      attemptId, hash, scriptId: script.id, provider: providerName, voice, usage,
      outcome: 'stored',
    });
    await client.query('COMMIT');
    inTransaction = false;
    return await publicCachedAudio(saved.rows[0], false, storage);
  } catch (error) {
    if (inTransaction) {
      try { await client.query('ROLLBACK'); } catch {}
      inTransaction = false;
    }
    if (usage) {
      const candidateCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const failureCode = typeof candidateCode === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(candidateCode)
        ? candidateCode : 'tts_generation_failed';
      try {
        await saveUsage(client, {
          attemptId, hash, scriptId: script.id, provider: providerName, voice, usage,
          outcome: 'failed_after_synthesis', failureCode,
        });
      } catch {}
    }
    throw error;
  } finally {
    client.release();
  }
}
