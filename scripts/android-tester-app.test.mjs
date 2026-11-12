/**
 * Тестовый APK обязан ставиться рядом с основным приложением, а не поверх него.
 * Проверяем на копии `app.json`: смена applicationId, схемы и имени, повторный
 * запуск без порчи резервной копии и точное восстановление.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/android-tester-app.mjs');

const original = {
  expo: {
    name: 'Vision Audio',
    slug: 'vision-audio',
    scheme: 'visionaudio',
    android: { package: 'app.vision.audio', versionCode: 7, permissions: ['INTERNET'] },
  },
};

function withAppJson() {
  const dir = mkdtempSync(path.join(tmpdir(), 'vision-tester-'));
  const file = path.join(dir, 'app.json');
  const text = `${JSON.stringify(original, null, 2)}\n`;
  writeFileSync(file, text);
  return { dir, file, text };
}

const run = (dir, extra = []) => {
  const result = spawnSync(process.execPath, [SCRIPT, ...extra], {
    env: { ...process.env, VISION_APP_DIR: dir, GITHUB_RUN_NUMBER: '42' },
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

test('тестовая сборка получает свой applicationId, имя и схему', () => {
  const { dir, file } = withAppJson();
  try {
    const { status, output } = run(dir);
    assert.equal(status, 0, output);
    const config = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(config.expo.android.package, 'app.vision.audio.tester');
    assert.equal(config.expo.name, 'Vision Audio Tester');
    assert.equal(config.expo.scheme, 'visiontester');
    assert.equal(config.expo.android.versionCode, 42);
    // остальное не тронуто
    assert.equal(config.expo.slug, 'vision-audio');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('повторный запуск не затирает резервную копию тестовой конфигурацией', () => {
  const { dir, file, text } = withAppJson();
  try {
    run(dir);
    run(dir);
    const backup = readFileSync(`${file}.vision-backup`, 'utf8');
    assert.equal(backup, text, 'резервная копия должна остаться исходной');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--restore возвращает исходный app.json байт в байт', () => {
  const { dir, file, text } = withAppJson();
  try {
    run(dir);
    const { status } = run(dir, ['--restore']);
    assert.equal(status, 0);
    assert.equal(readFileSync(file, 'utf8'), text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--restore без копии не падает', () => {
  const { dir } = withAppJson();
  try {
    const { status, output } = run(dir, ['--restore']);
    assert.equal(status, 0);
    assert.match(output, /восстанавливать нечего/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
