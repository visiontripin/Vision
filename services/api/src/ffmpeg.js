import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * Обёртка над ffmpeg: транскодинг в opus/aac, нормализация громкости (EBU R128,
 * −14 LUFS) и нарезка HLS. Бинарник ищем в таком порядке:
 *   1. `FFMPEG_PATH` (явный путь),
 *   2. пакет `ffmpeg-static` (если установлен),
 *   3. системный `ffmpeg` из PATH.
 *
 * Каждый кандидат **проверяется запуском** `ffmpeg -version`: файл может
 * существовать, но не работать в этой системе (типичный случай — `ffmpeg-static`
 * с glibc-сборкой на Android/Termux, где нужен `pkg install ffmpeg`).
 * Поэтому важен порядок, а не просто наличие файла.
 *
 * Если ffmpeg нет — сервис продолжает работать: отдаём оригинальный файл,
 * просто без «лёгких» вариантов и HLS.
 */

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 10 * 60 * 1000);

let resolved;
let resolving;
let versionCache;

/** Termux и любые Android-сборки Node: тут другой набор бинарников и мало CPU. */
export function isAndroid() {
  return process.platform === 'android' || Boolean(process.env.TERMUX_VERSION);
}

/** Кандидаты в порядке приоритета (без проверки запуска). */
export function ffmpegCandidates() {
  const list = [];
  if (process.env.FFMPEG_PATH) list.push(process.env.FFMPEG_PATH);

  try {
    const require = createRequire(import.meta.url);
    const staticPath = require('ffmpeg-static');
    if (typeof staticPath === 'string' && staticPath) list.push(staticPath);
  } catch {
    /* пакета нет — это нормально */
  }

  list.push('ffmpeg');
  return [...new Set(list)];
}

async function probe(binary) {
  // `existsSync` — быстрый фильтр, но недостаточный: проверяем запуск
  if (binary !== 'ffmpeg' && !existsSync(binary)) return null;
  try {
    const { stdout } = await execFileAsync(binary, ['-version'], { timeout: 5000 });
    const match = /ffmpeg version/i.test(stdout);
    return match ? (stdout.split('\n')[0]?.trim() ?? 'ffmpeg') : null;
  } catch {
    return null;
  }
}

/**
 * Первый **работоспособный** бинарник или null. Результат кэшируется;
 * `resetFfmpegCache()` сбрасывает кэш (нужно тестам и смене PATH на лету).
 */
export async function resolveFfmpeg() {
  if (resolved !== undefined) return resolved;

  if (!resolving) {
    resolving = (async () => {
      for (const candidate of ffmpegCandidates()) {
        if (await probe(candidate)) return candidate;
      }
      return null;
    })();
  }

  resolved = await resolving;
  return resolved;
}

/** Сбрасывает кэш резолва (используется в тестах). */
export function resetFfmpegCache() {
  resolved = undefined;
  resolving = undefined;
  versionCache = undefined;
}

/** Проверяет, что бинарник реально запускается. Результат кэшируется. */
export async function ffmpegAvailable() {
  return Boolean(await resolveFfmpeg());
}

export async function ffmpegVersion() {
  const binary = await resolveFfmpeg();
  if (!binary) return null;
  if (versionCache === undefined) versionCache = await probe(binary);
  return versionCache;
}

/**
 * Сколько потоков разрешить ffmpeg. На телефоне (Termux) по умолчанию 2 —
 * иначе транскодинг греет корпус и съедает батарею. `FFMPEG_THREADS=0` — «как хочет ffmpeg».
 */
export function ffmpegThreads() {
  const raw = process.env.FFMPEG_THREADS ?? (isAndroid() ? '2' : '');
  if (raw === '') return null;
  const value = Math.trunc(Number(raw));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(8, value);
}

function threadArgs() {
  const threads = ffmpegThreads();
  return threads ? ['-threads', String(threads)] : [];
}

const CODECS = {
  opus: {
    ext: 'ogg',
    mime: 'audio/ogg',
    args: (bitrate) => [
      '-c:a', 'libopus',
      '-b:a', `${bitrate}k`,
      '-vbr', 'on',
      '-compression_level', '10',
      '-application', 'audio',
      '-f', 'ogg',
    ],
  },
  aac: {
    ext: 'm4a',
    mime: 'audio/mp4',
    args: (bitrate) => [
      '-c:a', 'aac',
      '-b:a', `${bitrate}k`,
      '-movflags', '+faststart',
      '-f', 'mp4',
    ],
  },
};

export const DEFAULT_BITRATES = { opus: 96, aac: 128 };

/** −14 LUFS, true peak −1.5 dBTP: типичный ориентир для стриминга. */
export const LOUDNORM = 'loudnorm=I=-14:TP=-1.5:LRA=11';

export function codecInfo(codec) {
  return CODECS[codec] ?? null;
}

/**
 * Перекодирует аудио в opus или aac. Возвращает размер файла.
 * Нормализация включена по умолчанию — чтобы треки не прыгали по громкости.
 */
export async function transcodeAudio(inputPath, outputPath, options = {}) {
  const { codec = 'opus', bitrate = DEFAULT_BITRATES[codec] ?? 96, normalize = true } = options;
  const info = CODECS[codec];
  if (!info) throw new Error(`unknown codec ${codec}`);

  const binary = await resolveFfmpeg();
  if (!binary) throw new Error('ffmpeg_not_available');

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-i', inputPath,
    '-vn', '-map_metadata', '-1',
    ...threadArgs(),
    ...(normalize ? ['-af', LOUDNORM] : []),
    ...info.args(bitrate),
    outputPath,
  ];

  await execFileAsync(binary, args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  return info;
}

/**
 * Нарезает HLS: плейлист + сегменты по 6 секунд (по умолчанию).
 * Возвращает имя плейлиста относительно каталога.
 */
export async function transcodeToHls(inputPath, outDir, options = {}) {
  const { bitrate = 128, segmentSeconds = 6, normalize = true, playlist = 'index.m3u8' } = options;
  const binary = await resolveFfmpeg();
  if (!binary) throw new Error('ffmpeg_not_available');

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-i', inputPath,
    '-vn', '-map_metadata', '-1',
    ...threadArgs(),
    ...(normalize ? ['-af', LOUDNORM] : []),
    '-c:a', 'aac',
    '-b:a', `${bitrate}k`,
    '-f', 'hls',
    '-hls_time', String(segmentSeconds),
    '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', `${outDir}/seg-%03d.ts`,
    `${outDir}/${playlist}`,
  ];

  await execFileAsync(binary, args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  return playlist;
}
