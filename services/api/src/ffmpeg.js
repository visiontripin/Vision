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
 * Если ffmpeg нет — сервис продолжает работать: отдаём оригинальный файл,
 * просто без «лёгких» вариантов и HLS.
 */

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 10 * 60 * 1000);

let resolved;
let availablePromise;

export function resolveFfmpeg() {
  if (resolved !== undefined) return resolved;

  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);

  try {
    const require = createRequire(import.meta.url);
    const staticPath = require('ffmpeg-static');
    if (typeof staticPath === 'string' && staticPath) candidates.push(staticPath);
  } catch {
    /* пакета нет — это нормально */
  }

  candidates.push('ffmpeg');

  resolved = candidates.find((candidate) => candidate === 'ffmpeg' || existsSync(candidate)) ?? null;
  return resolved;
}

/** Проверяет, что бинарник реально запускается. Результат кэшируется. */
export function ffmpegAvailable() {
  if (!availablePromise) {
    availablePromise = (async () => {
      const binary = resolveFfmpeg();
      if (!binary) return false;
      try {
        const { stdout } = await execFileAsync(binary, ['-version'], { timeout: 5000 });
        return /ffmpeg version/i.test(stdout);
      } catch {
        return false;
      }
    })();
  }
  return availablePromise;
}

export async function ffmpegVersion() {
  const binary = resolveFfmpeg();
  if (!binary) return null;
  try {
    const { stdout } = await execFileAsync(binary, ['-version'], { timeout: 5000 });
    return stdout.split('\n')[0]?.trim() ?? null;
  } catch {
    return null;
  }
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

  const binary = resolveFfmpeg();
  if (!binary) throw new Error('ffmpeg_not_available');

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-i', inputPath,
    '-vn', '-map_metadata', '-1',
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
  const binary = resolveFfmpeg();
  if (!binary) throw new Error('ffmpeg_not_available');

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-i', inputPath,
    '-vn', '-map_metadata', '-1',
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
