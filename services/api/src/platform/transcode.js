// @ts-check
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

function ffmpegError(code, message) {
  return Object.assign(new Error(message), { code });
}

function runFfmpeg(ffmpegPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      shell: false,
    });
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGKILL');
      reject(ffmpegError('ffmpeg_timeout', 'Audio transcoding exceeded its time limit.'));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const errorCode = /** @type {NodeJS.ErrnoException} */ (error).code;
      reject(ffmpegError(errorCode === 'ENOENT' ? 'ffmpeg_unavailable' : 'ffmpeg_spawn_failed', 'Audio transcoder could not be started.'));
    });
    child.once('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(ffmpegError('ffmpeg_failed', 'Audio transcoder rejected or could not encode this input.'));
    });
  });
}

/**
 * Run fixed, metadata-stripping audio transforms. The input is untrusted and the
 * child is launched without a shell, with a hard timeout and no inherited stdio.
 * @param {string} inputPath
 * @param {{ffmpegPath?: string, timeoutMs?: number, outputDirectory?: string}} [options]
 */
export async function transcodeAudioFile(inputPath, {
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  timeoutMs = Number(process.env.PLATFORM_FFMPEG_TIMEOUT_MS || 10 * 60_000),
  outputDirectory,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60 * 60_000) {
    throw new Error('PLATFORM_FFMPEG_TIMEOUT_MS must be between 1000 and 3600000.');
  }
  const directory = outputDirectory || await mkdtemp(path.join(os.tmpdir(), 'vision-transcode-'));
  const opusPath = path.join(directory, 'transcoded.ogg');
  const aacPath = path.join(directory, 'transcoded.m4a');
  try {
    const common = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
      '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11'];
    await runFfmpeg(ffmpegPath, [
      ...common, '-c:a', 'libopus', '-b:a', '96k', '-application', 'audio', '-f', 'ogg', opusPath,
    ], timeoutMs);
    await runFfmpeg(ffmpegPath, [
      ...common, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'ipod', aacPath,
    ], timeoutMs);
    const [opus, aac] = await Promise.all([stat(opusPath), stat(aacPath)]);
    if (!opus.isFile() || !aac.isFile() || opus.size < 1 || aac.size < 1) {
      throw ffmpegError('ffmpeg_empty_output', 'Audio transcoder produced an empty output.');
    }
    return {
      directory,
      variants: [
        { codec: 'opus', contentType: 'audio/ogg', bitrateKbps: 96, path: opusPath, sizeBytes: opus.size },
        { codec: 'aac', contentType: 'audio/mp4', bitrateKbps: 128, path: aacPath, sizeBytes: aac.size },
      ],
      async cleanup() { await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    if (!outputDirectory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
