// @ts-check
import { createHash } from 'node:crypto';
import { PlatformAuthError } from './auth-crypto.js';

const MAX_CANDIDATES = 500;
const POSITIVE = new Map([['play_30s', 1], ['finish', 2], ['repeat', 1], ['start', 0.2]]);
const NEGATIVE = new Map([['skip_early', -1.5], ['segment_skip', -1]]);

function normalizeLimit(value, fallback = 20, max = 50) {
  const limit = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new PlatformAuthError('invalid_input', 400, `limit must be between 1 and ${max}.`);
  }
  return limit;
}

function normalizeTextFilter(value, label, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > maxLength) {
    throw new PlatformAuthError('invalid_input', 400, `${label} is invalid.`);
  }
  return value.trim().toLowerCase();
}

function recordWeight(map, key, weight) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + weight);
}

function normalizedPreference(map, key) {
  if (!key) return 0;
  const value = map.get(String(key).toLowerCase()) || 0;
  return Math.max(-1, Math.min(1, value / 4));
}

function deterministicTie(userId, trackId, day) {
  const bytes = createHash('sha256').update(`${userId}:${trackId}:${day}`).digest();
  return bytes.readUInt32BE(0) / 0xffffffff;
}

function dayStamp(nowMs) { return new Date(nowMs).toISOString().slice(0, 10); }

/**
 * Pure deterministic MMR-like ranking primitive used by request and offline evaluation.
 * @param {{userId: string, candidates: any[], history?: any[],
 *   profile?: {genreWeights?: Record<string, number>, moodWeights?: Record<string, number>, artistAffinity?: Record<string, number>},
 *   limit?: number, nowMs?: number}} options
 */
export function rankRecommendationCandidates({ userId, candidates, history = [], profile = {}, limit = 20, nowMs = Date.now() }) {
  const genreWeights = new Map();
  const moodWeights = new Map();
  const artistWeights = new Map();
  const lastSeen = new Map();
  for (const item of history) {
    const kind = item.kind;
    const baseWeight = POSITIVE.get(kind) ?? NEGATIVE.get(kind) ?? 0;
    if (!baseWeight) continue;
    const occurredAt = new Date(item.occurredAt).getTime();
    const ageDays = Math.max(0, (nowMs - occurredAt) / 86_400_000);
    const weight = baseWeight * Math.exp(-ageDays / 30);
    recordWeight(genreWeights, item.genre, weight);
    recordWeight(artistWeights, item.artistId, weight);
    for (const mood of item.mood || []) recordWeight(moodWeights, mood, weight);
    if (item.trackId) lastSeen.set(item.trackId, Math.max(lastSeen.get(item.trackId) || 0, occurredAt));
  }
  for (const [key, value] of Object.entries(profile.genreWeights || {})) recordWeight(genreWeights, key, Number(value) || 0);
  for (const [key, value] of Object.entries(profile.moodWeights || {})) recordWeight(moodWeights, key, Number(value) || 0);
  for (const [key, value] of Object.entries(profile.artistAffinity || {})) recordWeight(artistWeights, key, Number(value) || 0);

  const recentSkip = new Set(history
    .filter(({ kind, occurredAt }) => kind === 'skip_early' && nowMs - new Date(occurredAt).getTime() < 30 * 86_400_000)
    .map(({ trackId }) => trackId));
  const day = dayStamp(nowMs);
  const ranked = candidates.map((track) => {
    const genreScore = normalizedPreference(genreWeights, track.genre);
    const moodScores = (track.mood || []).map((mood) => normalizedPreference(moodWeights, mood));
    const moodScore = moodScores.length ? moodScores.reduce((a, b) => a + b, 0) / moodScores.length : 0;
    const artistScore = normalizedPreference(artistWeights, track.artistId);
    const vectorScore = Number.isFinite(Number(track.vectorScore)) ? Math.max(-1, Math.min(1, Number(track.vectorScore))) : 0;
    const ageDays = Math.max(0, (nowMs - new Date(track.publishedAt || nowMs).getTime()) / 86_400_000);
    const freshness = Math.exp(-ageDays / 90);
    const popularity = Math.min(1, Math.log1p(Math.max(0, Number(track.plays) || 0)) / 10);
    const score = (0.34 * genreScore) + (0.18 * moodScore) + (0.26 * artistScore)
      + (0.12 * vectorScore) + (0.06 * freshness) + (0.04 * popularity)
      + (0.00001 * deterministicTie(userId, track.id, day));
    return {
      ...track,
      score,
      reason: vectorScore > 0.2 ? 'similar_sound'
        : artistScore > 0.2 ? 'artist_affinity'
          : genreScore > 0.2 ? 'genre_affinity'
            : moodScore > 0.2 ? 'mood_affinity' : 'fresh_for_you',
      _negativeSkip: recentSkip.has(track.id),
    };
  }).filter((track) => !track._negativeSkip)
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));

  const selected = [];
  const ownerCounts = new Map();
  const genreCounts = new Map();
  const remaining = [...ranked];
  while (remaining.length && selected.length < limit) {
    remaining.sort((a, b) => {
      const aGenre = String(a.genre || '').toLowerCase();
      const bGenre = String(b.genre || '').toLowerCase();
      const aAdjusted = a.score - 0.16 * (ownerCounts.get(a.artistId) || 0) - 0.05 * (genreCounts.get(aGenre) || 0);
      const bAdjusted = b.score - 0.16 * (ownerCounts.get(b.artistId) || 0) - 0.05 * (genreCounts.get(bGenre) || 0);
      return bAdjusted - aAdjusted || String(a.id).localeCompare(String(b.id));
    });
    const [next] = remaining.splice(0, 1);
    if (!next) break;
    const { _negativeSkip, ...publicTrack } = next;
    selected.push(publicTrack);
    ownerCounts.set(next.artistId, (ownerCounts.get(next.artistId) || 0) + 1);
    const genre = String(next.genre || '').toLowerCase();
    genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
  }
  return selected;
}

/** Deterministic offline ranking metrics; callers must provide a non-sensitive fixture dataset. */
export function evaluateRecommendationFixtures(fixtures, { k = 20, nowMs = Date.UTC(2026, 0, 1) } = {}) {
  if (!Array.isArray(fixtures) || fixtures.length < 1 || fixtures.length > 10_000) {
    throw new PlatformAuthError('invalid_input', 400, 'At least one bounded evaluation fixture is required.');
  }
  const safeK = normalizeLimit(k, 20, 100);
  let totalRecall = 0;
  let totalNdcg = 0;
  const catalog = new Set();
  const recommended = new Set();
  let count = 0;
  for (const fixture of fixtures) {
    if (!Array.isArray(fixture.relevantIds) || !Array.isArray(fixture.candidates)) throw new PlatformAuthError('invalid_input', 400, 'Evaluation fixtures require candidates and relevantIds.');
    const ranking = rankRecommendationCandidates({ ...fixture, limit: safeK, nowMs });
    const relevant = new Set(fixture.relevantIds.map(String));
    let hits = 0;
    let dcg = 0;
    for (const [index, item] of ranking.entries()) {
      catalog.add(String(item.id));
      recommended.add(String(item.id));
      if (relevant.has(String(item.id))) {
        hits += 1;
        dcg += 1 / Math.log2(index + 2);
      }
    }
    const ideal = Math.min(relevant.size, safeK);
    let idcg = 0;
    for (let index = 0; index < ideal; index += 1) idcg += 1 / Math.log2(index + 2);
    totalRecall += relevant.size ? hits / relevant.size : 0;
    totalNdcg += idcg ? dcg / idcg : 0;
    count += 1;
    for (const candidate of fixture.candidates) catalog.add(String(candidate.id));
  }
  return {
    recallAtK: totalRecall / count,
    ndcgAtK: totalNdcg / count,
    catalogCoverage: catalog.size ? recommended.size / catalog.size : 0,
    fixtureCount: count,
    k: safeK,
  };
}

/** Rank only currently public, rights-confirmed and moderation-approved tracks. */
export async function getRecommendations(pool, userId, searchParams, { nowMs = Date.now() } = {}) {
  const limit = normalizeLimit(searchParams?.get('limit') ?? undefined, 20, 50);
  const genre = normalizeTextFilter(searchParams?.get('genre') ?? undefined, 'genre', 100);
  const mood = normalizeTextFilter(searchParams?.get('mood') ?? undefined, 'mood', 50);
  const historyWindow = new Date(nowMs - 30 * 86_400_000);
  const historyRows = await pool.query(`
    SELECT history."trackId", history.kind, history."occurredAt",
      t.genre, t.mood, t.owner_id AS "artistId"
    FROM (
      SELECT e.track_id AS "trackId", e.kind, e.occurred_at AS "occurredAt"
      FROM play_events e WHERE e.user_id = $1 AND e.occurred_at >= $2
      UNION ALL
      SELECT s.ref_id AS "trackId",
        CASE f.reaction WHEN 'like' THEN 'finish' ELSE 'skip_early' END AS kind,
        f.created_at AS "occurredAt"
      FROM radio_feedback f
      JOIN radio_schedule s ON s.id = f.schedule_id AND s.segment_type = 'music'
      WHERE f.user_id = $1 AND f.created_at >= $2 AND f.reaction IN ('like', 'dislike', 'skip')
    ) history
    LEFT JOIN tracks t ON t.id = history."trackId"
    ORDER BY history."occurredAt" DESC LIMIT 5000
  `, [userId, historyWindow]);
  const profileResult = await pool.query(`
    SELECT centroid IS NOT NULL AS has_centroid, genre_weights AS "genreWeights",
      mood_weights AS "moodWeights", artist_affinity AS "artistAffinity"
    FROM taste_profiles WHERE user_id = $1
  `, [userId]);
  const profile = profileResult.rows[0] || {};
  const candidateResult = await pool.query(`
    SELECT t.id, t.owner_id AS "artistId", t.title, t.artist_display AS artist,
      t.album, t.genre, t.mood, t.duration_ms AS "durationMs", t.plays,
      t.published_at AS "publishedAt",
      CASE WHEN tp.centroid IS NOT NULL AND t.embedding IS NOT NULL
        THEN 1.0 - (t.embedding <=> tp.centroid) ELSE 0.0 END AS "vectorScore"
    FROM tracks t
    LEFT JOIN taste_profiles tp ON tp.user_id = $1
    WHERE t.status = 'published' AND t.visibility = 'public'
      AND t.rights_confirmed_at IS NOT NULL AND t.rights_offer_version IS NOT NULL
      AND ($2::text IS NULL OR lower(t.genre) = $2)
      AND ($3::text IS NULL OR $3 = ANY(t.mood))
      AND EXISTS (
        SELECT 1 FROM (
          SELECT m.status, m.decided_at FROM moderation_queue m WHERE m.track_id = t.id
          ORDER BY m.created_at DESC, m.id DESC LIMIT 1
        ) latest WHERE latest.status = 'approved' AND latest.decided_at IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM rights_claims c WHERE c.track_id = t.id
          AND c.status IN ('open', 'counter_notice', 'accepted')
      )
    ORDER BY t.published_at DESC NULLS LAST, t.id
    LIMIT $4
  `, [userId, genre, mood, MAX_CANDIDATES]);
  const recommendations = rankRecommendationCandidates({
    userId,
    candidates: candidateResult.rows,
    history: historyRows.rows,
    profile: {
      genreWeights: profile.genreWeights,
      moodWeights: profile.moodWeights,
      artistAffinity: profile.artistAffinity,
    },
    limit,
    nowMs,
  });
  return {
    modelVersion: 'deterministic-v1',
    items: recommendations.map((track) => ({
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      genre: track.genre,
      mood: track.mood,
      durationMs: track.durationMs,
      plays: Number(track.plays),
      publishedAt: track.publishedAt,
      reason: track.reason,
      score: Number(track.score.toFixed(6)),
    })),
    limit,
  };
}

/** Persist a reviewed offline evaluation snapshot; no recommendation policy is auto-promoted. */
export async function recordRecommendationEvaluation(pool, { modelVersion, datasetVersion, metrics }) {
  if (typeof modelVersion !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(modelVersion)
    || typeof datasetVersion !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(datasetVersion)) {
    throw new PlatformAuthError('invalid_input', 400, 'modelVersion and datasetVersion must be short identifiers.');
  }
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)
    || Object.values(metrics).some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw new PlatformAuthError('invalid_input', 400, 'metrics must be an object of finite non-negative numbers.');
  }
  const result = await pool.query(`
    INSERT INTO recsys_evaluations (model_version, dataset_version, metrics)
    VALUES ($1, $2, $3::jsonb) RETURNING id, model_version AS "modelVersion",
      dataset_version AS "datasetVersion", metrics, created_at AS "createdAt"
  `, [modelVersion, datasetVersion, JSON.stringify(metrics)]);
  return result.rows[0];
}
