import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { MEDIA_DIR, getTrackFile, getVariant, upsertVariant, tracksMissingVariants } from './db.js';
import { inc } from './metrics.js';
import { DEFAULT_BITRATES, codecInfo, ffmpegAvailable, transcodeAudio, transcodeToHls } from './ffmpeg.js';

/**
 * Очередь фонового транскодинга.
 *
 * Работает в том же процессе (личная библиотека — не нужен отдельный воркер и
 * брокер), по одному треку за раз, чтобы не забивать CPU. Если ffmpeg нет,
 * очередь просто молчит: приложение отдаёт оригиналы.
 */

export const VARIANTS_DIR = path.join(MEDIA_DIR, 'variants');
export const HLS_DIR = path.join(MEDIA_DIR, 'hls');

const enabled = () => process.env.TRANSCODE !== '0';
const codecs = () =>
  String(process.env.TRANSCODE_CODECS || 'opus,aac')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => codecInfo(value));
const hlsEnabled = () => process.env.HLS_ENABLED !== '0';

const queue = [];
const queued = new Set();
let running = false;
let processed = 0;
let failed = 0;
let lastError = null;

export function transcodeStatus() {
  return {
    enabled: enabled(),
    queued: queue.length,
    busy: running,
    processed,
    failed,
    lastError,
  };
}

export function variantPath(trackId, codec) {
  const info = codecInfo(codec);
  return info ? path.join(VARIANTS_DIR, `${trackId}.${codec}.${info.ext}`) : null;
}

export function hlsPath(trackId) {
  return path.join(HLS_DIR, trackId);
}

/** Ставит трек в очередь. Повторные постановки игнорируются. */
export function enqueueTranscode(trackId) {
  if (!enabled() || !trackId || queued.has(trackId)) return false;
  queued.add(trackId);
  queue.push(trackId);
  void pump();
  return true;
}

async function pump() {
  if (running) return;
  running = true;

  try {
    if (!(await ffmpegAvailable())) {
      queue.length = 0;
      queued.clear();
      return;
    }

    while (queue.length) {
      const trackId = queue.shift();
      try {
        await transcodeTrack(trackId);
        processed += 1;
      } catch (error) {
        failed += 1;
        lastError = String(error?.message || error);
        inc('vision_transcode_total', 1, { result: 'error' });
      } finally {
        queued.delete(trackId);
      }
    }
  } finally {
    running = false;
  }
}

async function fileSize(filePath) {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

/** Перекодирует один трек: opus + aac + HLS (что включено). */
export async function transcodeTrack(trackId) {
  const meta = getTrackFile(trackId);
  if (!meta?.ext) return;

  const input = path.join(MEDIA_DIR, `${trackId}.${meta.ext}`);
  if (!(await fileSize(input))) return;

  await mkdir(VARIANTS_DIR, { recursive: true });

  for (const codec of codecs()) {
    if (getVariant(trackId, codec)) continue;
    const info = codecInfo(codec);
    const output = variantPath(trackId, codec);
    const started = Date.now();

    await transcodeAudio(input, output, {
      codec,
      bitrate: DEFAULT_BITRATES[codec],
      normalize: process.env.TRANSCODE_NORMALIZE !== '0',
    });

    upsertVariant({
      trackId,
      kind: codec,
      mime: info.mime,
      ext: info.ext,
      size: await fileSize(output),
      bitrate: DEFAULT_BITRATES[codec],
    });
    inc('vision_transcode_total', 1, { result: codec });
    inc('vision_transcode_seconds_total', (Date.now() - started) / 1000, { kind: codec });
  }

  if (hlsEnabled() && !getVariant(trackId, 'hls')) {
    const dir = hlsPath(trackId);
    await mkdir(dir, { recursive: true });
    const started = Date.now();

    await transcodeToHls(input, dir, {
      bitrate: DEFAULT_BITRATES.aac,
      segmentSeconds: Number(process.env.HLS_SEGMENT_SECONDS || 6),
      normalize: process.env.TRANSCODE_NORMALIZE !== '0',
    });

    upsertVariant({
      trackId,
      kind: 'hls',
      mime: 'application/vnd.apple.mpegurl',
      ext: 'm3u8',
      size: await fileSize(path.join(dir, 'index.m3u8')),
      bitrate: DEFAULT_BITRATES.aac,
    });
    inc('vision_transcode_total', 1, { result: 'hls' });
    inc('vision_transcode_seconds_total', (Date.now() - started) / 1000, { kind: 'hls' });
  }
}

/** Убирает файлы вариантов при удалении трека. */
export async function removeVariants(trackId) {
  await rm(hlsPath(trackId), { recursive: true, force: true }).catch(() => {});
  for (const codec of ['opus', 'aac']) {
    const file = variantPath(trackId, codec);
    if (file) await rm(file, { force: true }).catch(() => {});
  }
}

/** Догоняет треки, загруженные до включения ffmpeg. */
export async function backfillVariants(limit = 50) {
  if (!enabled() || !(await ffmpegAvailable())) return 0;
  const rows = tracksMissingVariants(limit);
  for (const row of rows) enqueueTranscode(row.id);
  return rows.length;
}
