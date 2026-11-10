/**
 * Трекер реплик: кто прямо сейчас может отдать содержимое (sha256) и как его
 * забрать. Сервер здесь — только реестр и метаданные, аудио живёт на устройствах.
 *
 * Модель (docs/DISTRIBUTED.md):
 *   blobs      — содержимое: hash, размер, mime;
 *   blob_seeds — устройство-сид с heartbeat;
 *   /seed/:hash?exp&sig — отдача файла с любого сида (подпись общая, HMAC).
 *
 * Никаких битфилдов и чанков: файл качается целиком по HTTPS с Range, SHA-256
 * проверяется после скачивания. Для домашней библиотеки этого достаточно, а
 * ошибиться в реализации «настоящего торрента» без нужды дороже.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { Readable } from 'node:stream';

import { db, DATA_DIR, MEDIA_DIR } from './db.js';
import { signMedia, verifyMedia, MEDIA_TTL_MS, log } from './lib.js';

/* ------------------------------- настройки -------------------------------- */

export const STORAGE_MODE = process.env.STORAGE_MODE === 'metadata' ? 'metadata' : 'local';
export const SEED_ENABLED = process.env.SEED_ENABLED !== '0';
export const DEVICE_ID = process.env.DEVICE_ID || 'origin';
export const SEED_DIR = path.resolve(process.env.SEED_DIR || path.join(DATA_DIR, 'seed'));
/** Сколько живёт heartbeat: 3 минуты по умолчанию, обновляется раз в минуту. */
export const SEED_TTL_MS = Math.max(30_000, Number(process.env.SEED_TTL_MS || 3 * 60_000));
/**
 * Копии, которые раздавать не умеют (браузер, телефон в фоне), живут в реестре
 * долго: это «у меня есть файл», а не «я сейчас онлайн». 30 дней.
 */
export const REPLICA_TTL_MS = Math.max(SEED_TTL_MS, Number(process.env.REPLICA_TTL_MS || 30 * 24 * 3600_000));
/** Публичный адрес узла — нужен, чтобы другие знали, откуда качать. */
export const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

mkdirSync(SEED_DIR, { recursive: true });

/** Порядок предпочтения сидов: свой origin → узел → десктоп → телефон → браузер. */
const KIND_RANK = { origin: 0, node: 1, desktop: 2, mobile: 3, browser: 4 };
/** Только эти виды сидов умеют отдать файл по HTTP. */
const SERVABLE_KINDS = new Set(['origin', 'node', 'desktop']);

export const EXT_BY_MIME = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
};

export const MIME_BY_EXT = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime]).filter(([ext]) => ext !== 'opus' && ext !== 'aac')
);

export const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const extForMime = (mime) => EXT_BY_MIME[String(mime || '').toLowerCase()] || 'bin';
export const mimeForExt = (ext) => MIME_BY_EXT[String(ext || '').toLowerCase()] || 'application/octet-stream';

/* --------------------------------- блобы ---------------------------------- */

export function declareBlob({ hash, bytes = 0, mime = 'application/octet-stream' }) {
  if (!isHash(hash)) return null;
  const size = Math.max(0, Number(bytes) || 0);
  db.prepare(
    `INSERT INTO blobs (hash, bytes, mime, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(hash) DO UPDATE SET
       bytes = MAX(blobs.bytes, excluded.bytes),
       mime  = CASE WHEN excluded.mime <> 'application/octet-stream' THEN excluded.mime ELSE blobs.mime END`
  ).run(hash, size, String(mime || 'application/octet-stream'), new Date().toISOString());
  return getBlob(hash);
}

export function getBlob(hash) {
  if (!isHash(hash)) return null;
  const row = db.prepare('SELECT * FROM blobs WHERE hash = ?').get(hash);
  return row ? { hash: row.hash, bytes: row.bytes, mime: row.mime, createdAt: row.created_at } : null;
}

export function deleteBlob(hash) {
  if (!isHash(hash)) return false;
  return db.prepare('DELETE FROM blobs WHERE hash = ?').run(hash).changes > 0;
}

/* --------------------------------- сиды ----------------------------------- */

/**
 * Heartbeat устройства-сида. Один вызов = «я жив и могу отдать этот файл».
 * `baseUrl` обязателен для тех, кто умеет раздавать (origin/node/desktop).
 */
export function registerSeed({ hash, deviceId = DEVICE_ID, kind = 'node', baseUrl = null, ttlHint = null }) {
  if (!isHash(hash)) return null;
  const cleanBase = baseUrl ? String(baseUrl).replace(/\/$/, '').slice(0, 500) : null;
  const servable = SERVABLE_KINDS.has(kind) && Boolean(cleanBase || kind === 'origin');
  const now = Date.now();

  declareBlob({ hash });

  db.prepare(
    `INSERT INTO blob_seeds (hash, device_id, kind, base_url, servable, online_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(hash, device_id) DO UPDATE SET
       kind      = excluded.kind,
       base_url  = COALESCE(excluded.base_url, blob_seeds.base_url),
       servable  = excluded.servable,
       online_at = excluded.online_at`
  ).run(hash, String(deviceId).slice(0, 120), kind, cleanBase, servable ? 1 : 0, now);

  if (ttlHint) pruneSeeds();
  return { hash, deviceId, kind, baseUrl: cleanBase, servable, onlineAt: now };
}

export function removeSeed(hash, deviceId) {
  if (!isHash(hash)) return false;
  return db.prepare('DELETE FROM blob_seeds WHERE hash = ? AND device_id = ?').run(hash, String(deviceId)).changes > 0;
}

export function pruneSeeds() {
  const now = Date.now();
  return db
    .prepare('DELETE FROM blob_seeds WHERE (servable = 1 AND online_at < ?) OR (servable = 0 AND online_at < ?)')
    .run(now - SEED_TTL_MS, now - REPLICA_TTL_MS).changes;
}

function toSeed(row) {
  return {
    deviceId: row.device_id,
    kind: row.kind,
    baseUrl: row.base_url,
    servable: Boolean(row.servable),
    onlineAt: new Date(row.online_at).toISOString(),
    ageMs: Date.now() - row.online_at,
  };
}

/** Живые сиды блоба, начиная с самых предпочтительных. */
export function listSeeds(hash, { ttlMs = SEED_TTL_MS, includeStale = false } = {}) {
  if (!isHash(hash)) return [];
  const rows = includeStale
    ? db.prepare('SELECT * FROM blob_seeds WHERE hash = ?').all(hash)
    : db.prepare('SELECT * FROM blob_seeds WHERE hash = ? AND online_at >= ?').all(hash, Date.now() - ttlMs);

  return rows
    .map(toSeed)
    .sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || b.ageMs - a.ageMs);
}

/** Сводка «есть у кого» для набора блобов — одним запросом, без N+1. */
export function seedSummary(hashes = []) {
  const unique = [...new Set(hashes.filter(isHash))];
  const result = new Map();
  const cutoff = Date.now() - SEED_TTL_MS;
  const replicaCutoff = Date.now() - REPLICA_TTL_MS;

  for (let i = 0; i < unique.length; i += 300) {
    const chunk = unique.slice(i, i + 300);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT hash, kind, servable, COUNT(*) AS n
           FROM blob_seeds
          WHERE hash IN (${placeholders})
            AND ((servable = 1 AND online_at >= ?) OR (servable = 0 AND online_at >= ?))
          GROUP BY hash, kind, servable`
      )
      .all(...chunk, cutoff, replicaCutoff);

    for (const row of rows) {
      const entry = result.get(row.hash) || { servable: 0, replicas: 0, devices: 0, kinds: {} };
      entry.devices += row.n;
      if (row.servable) entry.servable += row.n;
      else entry.replicas += row.n;
      entry.kinds[row.kind] = (entry.kinds[row.kind] || 0) + row.n;
      result.set(row.hash, entry);
    }
  }

  for (const hash of unique) if (!result.has(hash)) result.set(hash, { servable: 0, replicas: 0, devices: 0, kinds: {} });
  return result;
}

/* ------------------------------- локальные файлы --------------------------- */

let seedDirCache = { at: 0, files: new Map() };

/** Содержимое каталога сида с коротким кэшем: <hash>.<ext> → путь. */
function seedFiles() {
  if (Date.now() - seedDirCache.at < 2000) return seedDirCache.files;
  const files = new Map();
  try {
    for (const name of readdirSync(SEED_DIR)) {
      const [hash, ext] = name.split('.');
      if (isHash(hash) && ext) files.set(hash, path.join(SEED_DIR, name));
    }
  } catch { /* каталога ещё нет */ }
  seedDirCache = { at: Date.now(), files };
  return files;
}

/** Файл блоба на этом узле: сначала каталог сида, потом медиа-каталог origin. */
export function localFileFor(hash) {
  if (!isHash(hash)) return null;
  const blob = getBlob(hash);
  const ext = extForMime(blob?.mime);
  const candidates = [];

  const seeded = seedFiles().get(hash);
  if (seeded) candidates.push(seeded);
  if (ext !== 'bin') candidates.push(path.join(SEED_DIR, `${hash}.${ext}`));

  const track = db.prepare('SELECT id, ext, mime FROM tracks WHERE checksum = ?').get(hash);
  if (track?.ext) candidates.push(path.join(MEDIA_DIR, `${track.id}.${track.ext}`));

  for (const file of candidates) {
    try {
      if (existsSync(file) && statSync(file).size > 0) {
        return { file, mime: track?.mime || blob?.mime || mimeForExt(path.extname(file).slice(1)) };
      }
    } catch { /* файл только что удалили — не беда */ }
  }
  return null;
}

/** Все хеши, которые этот узел реально может отдать. */
export function localBlobHashes() {
  const hashes = new Set();
  for (const row of db.prepare('SELECT DISTINCT checksum FROM tracks WHERE checksum IS NOT NULL').all()) {
    if (isHash(row.checksum) && localFileFor(row.checksum)) hashes.add(row.checksum);
  }
  try {
    for (const file of readdirSync(SEED_DIR)) {
      const [hash, ext] = file.split('.');
      if (!isHash(hash) || !ext) continue;
      declareBlob({ hash, mime: mimeForExt(ext), bytes: statSync(path.join(SEED_DIR, file)).size });
      hashes.add(hash);
    }
  } catch { /* нет каталога — нечего раздавать */ }
  return [...hashes];
}

/** Периодический heartbeat: «я всё ещё раздаю вот это». */
export function heartbeatSelf(baseUrl = PUBLIC_URL) {
  const hashes = localBlobHashes();
  for (const hash of hashes) {
    registerSeed({ hash, deviceId: DEVICE_ID, kind: 'origin', baseUrl: baseUrl || null });
  }
  return hashes.length;
}

/** Убирает из реестра сиды этого устройства по блобам, которых больше нет. */
export function reconcileSelf() {
  const local = new Set(localBlobHashes());
  const mine = db.prepare('SELECT hash FROM blob_seeds WHERE device_id = ?').all(DEVICE_ID);
  let removed = 0;
  for (const row of mine) {
    if (!local.has(row.hash)) {
      db.prepare('DELETE FROM blob_seeds WHERE hash = ? AND device_id = ?').run(row.hash, DEVICE_ID);
      removed += 1;
    }
  }
  return removed;
}

/* ---------------------------- подписанные ссылки -------------------------- */

/** Ссылка на скачивание с конкретного сида: подпись общая, но живёт 30 минут. */
export function seedUrl(baseUrl, hash, ttlMs = MEDIA_TTL_MS) {
  if (!baseUrl || !isHash(hash)) return null;
  const { exp, sig } = signMedia(hash, 'seed', ttlMs);
  return `${String(baseUrl).replace(/\/$/, '')}/seed/${hash}?exp=${exp}&sig=${sig}`;
}

export const verifySeedToken = (hash, exp, sig) => verifyMedia(hash, 'seed', exp, sig);

/* --------------------------- выдача для треков ---------------------------- */

/**
 * Дополняет треки сведениями об источниках:
 *   sources.servable — сколько устройств реально может отдать файл;
 *   sources.replicas — копии, которые есть, но раздавать не умеют (телефон/браузер);
 *   available        — можно ли вообще воспроизвести (локальный файл или живой сид).
 */
export function withSources(tracks, { selfBase = '' } = {}) {
  const list = Array.isArray(tracks) ? tracks : [tracks];
  const hashes = list.map((track) => track?.checksum).filter(isHash);
  const summary = seedSummary(hashes);

  const enriched = list.map((track) => {
    if (!track) return track;
    const hash = isHash(track.checksum) ? track.checksum : null;
    const stats = hash ? summary.get(hash) : null;
    const local = hash ? Boolean(localFileFor(hash)) : false;
    const kinds = { ...(stats?.kinds ?? {}) };
    if (local && !kinds.origin) kinds.origin = 1;

    const sources = {
      hash,
      local,
      servable: Math.max(stats?.servable ?? 0, local ? 1 : 0),
      replicas: stats?.replicas ?? 0,
      devices: Math.max(stats?.devices ?? 0, local ? 1 : 0),
      kinds,
    };

    return {
      ...track,
      sources,
      available: local || (stats?.servable ?? 0) > 0,
    };
  });

  return Array.isArray(tracks) ? enriched : enriched[0];
}

/**
 * Куда отправить клиента за файлом: локальный стрим, живой сид или «нет источника».
 * Возвращает `{ url, seed, local }`, где url уже с подписью.
 */
export function resolveDownload(track, { selfBase = '' } = {}) {
  if (!track) return null;
  const hash = isHash(track.checksum) ? track.checksum : null;
  if (!hash) return null;

  const local = localFileFor(hash);
  // локально — отдаём напрямую с /seed, иначе получился бы редирект сам на себя
  if (local) {
    const { exp, sig } = signMedia(hash, 'seed');
    return { url: `/seed/${hash}?exp=${exp}&sig=${sig}`, local: true, seed: null, hash };
  }

  // Сюда попадаем, только если локального файла нет: свой узел из списка исключаем,
  // даже если heartbeat ещё не успел снять протухшую запись (иначе 404 вместо пира).
  const seeds = listSeeds(hash).filter(
    (seed) => seed.servable && seed.deviceId !== DEVICE_ID && Boolean(seed.baseUrl)
  );
  const pick = seeds[0];
  if (!pick) return null;

  const url = seedUrl(pick.baseUrl, hash);
  return url ? { url, local: false, seed: pick, hash } : null;
}

/* --------------------------- репликация на узел --------------------------- */

/**
 * Забрать блоб с живого сида и положить в каталог сида этого узла.
 * Используется, когда Termux-узел хочет «подстраховать» редкий трек.
 */
export async function adoptBlob(hash, { ttlMs = MEDIA_TTL_MS } = {}) {
  if (!isHash(hash)) return { ok: false, reason: 'invalid_hash' };
  const existing = localFileFor(hash);
  if (existing) return { ok: true, already: true, file: existing.file };

  const seeds = listSeeds(hash).filter((seed) => seed.servable && seed.baseUrl);
  if (!seeds.length) return { ok: false, reason: 'no_source' };

  const blob = getBlob(hash) || declareBlob({ hash });
  const ext = extForMime(blob.mime);
  const target = path.join(SEED_DIR, `${hash}.${ext}`);
  const tmp = path.join(SEED_DIR, `.incoming-${hash.slice(0, 12)}`);

  for (const seed of seeds) {
    const url = seedUrl(seed.baseUrl, hash, ttlMs);
    if (!url) continue;
    try {
      const response = await fetch(url);
      if (!response.ok || !response.body) continue;

      const sink = createWriteStream(tmp);
      const digest = createHash('sha256');
      let received = 0;

      for await (const chunk of Readable.fromWeb(response.body)) {
        received += chunk.length;
        digest.update(chunk);
        if (!sink.write(chunk)) await once(sink, 'drain');
      }
      sink.end();
      await once(sink, 'finish');

      if (digest.digest('hex') !== hash) {
        await rm(tmp, { force: true });
        log('error', 'seed replica checksum mismatch', { hash, seed: seed.deviceId });
        continue;
      }

      await rename(tmp, target);
      declareBlob({ hash, bytes: received, mime: blob.mime });
      registerSeed({ hash, deviceId: DEVICE_ID, kind: 'origin', baseUrl: PUBLIC_URL || null });
      return { ok: true, already: false, bytes: received, file: target, from: seed.deviceId };
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      log('error', 'seed replica failed', { hash, seed: seed.deviceId, error: error?.message });
    }
  }

  return { ok: false, reason: 'no_source' };
}

/* ------------------------------- статистика ------------------------------- */

export function trackerStats() {
  const cutoff = Date.now() - SEED_TTL_MS;
  const blobs = db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n;
  const online = db.prepare('SELECT COUNT(*) AS n FROM blob_seeds WHERE servable = 1 AND online_at >= ?').get(cutoff).n;
  const replicas = db.prepare('SELECT COUNT(*) AS n FROM blob_seeds WHERE servable = 0 AND online_at >= ?')
    .get(Date.now() - REPLICA_TTL_MS).n;
  const servable = db.prepare('SELECT COUNT(DISTINCT hash) AS n FROM blob_seeds WHERE online_at >= ? AND servable = 1')
    .get(cutoff).n;
  const withLocal = db
    .prepare("SELECT COUNT(*) AS n FROM tracks WHERE checksum IS NOT NULL")
    .get().n;
  const noSource = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tracks t
        WHERE t.checksum IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM blob_seeds s
             WHERE s.hash = t.checksum AND s.online_at >= ? AND s.servable = 1
          )`
    )
    .get(cutoff).n;

  return {
    mode: STORAGE_MODE,
    seedEnabled: SEED_ENABLED,
    deviceId: DEVICE_ID,
    publicUrl: PUBLIC_URL || null,
    seedDir: SEED_DIR,
    ttlMs: SEED_TTL_MS,
    blobs,
    seeds: online,
    replicas,
    servableBlobs: servable,
    localBlobs: withLocal,
    noSource,
  };
}
