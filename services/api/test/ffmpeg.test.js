import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Резолв ffmpeg — единственное место, где сервис решает, будет ли транскодинг.
 * Ошибиться тут легко: файл `ffmpeg-static` существует, но на Android не
 * запускается, и без проверки запуска сервис молча остаётся без вариантов.
 */

const require = createRequire(import.meta.url);
let ffmpegStaticPresent = false;
try {
  ffmpegStaticPresent = Boolean(require('ffmpeg-static'));
} catch {
  ffmpegStaticPresent = false;
}

async function fakeBinary(dir, name, works) {
  const file = path.join(dir, name);
  await writeFile(file, works ? '#!/bin/sh\necho "ffmpeg version 9.9-fake"\n' : '#!/bin/sh\nexit 1\n');
  await chmod(file, 0o755);
  return file;
}

async function loadFfmpeg() {
  // отдельный экземпляр модуля = чистый кэш резолва
  return import(`../src/ffmpeg.js?probe=${Date.now()}${Math.random()}`);
}

async function withEnv(patch, run) {
  const saved = {};
  for (const key of Object.keys(patch)) {
    saved[key] = process.env[key];
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('ffmpeg: рабочий FFMPEG_PATH имеет приоритет', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vision-ff-'));
  try {
    const good = await fakeBinary(dir, 'good-ffmpeg', true);
    await withEnv({ FFMPEG_PATH: good }, async () => {
      const mod = await loadFfmpeg();
      assert.equal(await mod.resolveFfmpeg(), good);
      assert.equal(await mod.ffmpegAvailable(), true);
      assert.match(await mod.ffmpegVersion(), /ffmpeg version 9\.9-fake/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ffmpeg: существующий, но нерабочий бинарник пропускается', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vision-ff-'));
  const binDir = await mkdtemp(path.join(tmpdir(), 'vision-bin-'));
  try {
    const broken = await fakeBinary(dir, 'broken-ffmpeg', false);
    await fakeBinary(binDir, 'ffmpeg', true);

    await withEnv({ FFMPEG_PATH: broken, PATH: `${binDir}:/usr/bin:/bin`, HLS_ENABLED: undefined }, async () => {
      const mod = await loadFfmpeg();
      const resolved = await mod.resolveFfmpeg();
      assert.notEqual(resolved, broken, 'битый FFMPEG_PATH не должен выбираться');
      assert.equal(await mod.ffmpegAvailable(), true);
      // если ffmpeg-static не установлен, после битого пути должен взяться PATH
      if (!ffmpegStaticPresent) assert.equal(resolved, 'ffmpeg');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test('ffmpeg: без рабочих кандидатов транскодинг выключен, но модуль жив', async (t) => {
  if (ffmpegStaticPresent) {
    t.skip('в окружении установлен ffmpeg-static — проверка «нет ffmpeg» невозможна');
    return;
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'vision-empty-'));
  try {
    await withEnv({ FFMPEG_PATH: undefined, PATH: dir }, async () => {
      const mod = await loadFfmpeg();
      assert.equal(await mod.resolveFfmpeg(), null);
      assert.equal(await mod.ffmpegAvailable(), false);
      assert.equal(await mod.ffmpegVersion(), null);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ffmpeg: на Android/Termux по умолчанию 2 потока и только opus', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vision-ff-'));
  try {
    const good = await fakeBinary(dir, 'good-ffmpeg', true);
    await withEnv({ FFMPEG_PATH: good, FFMPEG_THREADS: undefined, TERMUX_VERSION: '0.118' }, async () => {
      const mod = await loadFfmpeg();
      assert.equal(mod.isAndroid(), true);
      assert.equal(mod.ffmpegThreads(), 2);
    });

    await withEnv({ FFMPEG_PATH: good, FFMPEG_THREADS: '0', TERMUX_VERSION: undefined }, async () => {
      const mod = await loadFfmpeg();
      assert.equal(mod.ffmpegThreads(), null, '0 = отдать выбор ffmpeg');
    });

    await withEnv({ FFMPEG_PATH: good, FFMPEG_THREADS: '16' }, async () => {
      const mod = await loadFfmpeg();
      assert.equal(mod.ffmpegThreads(), 8, 'значение ограничено восемью потоками');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
