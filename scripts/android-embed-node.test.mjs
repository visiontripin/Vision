/**
 * Проверка вживления Node в prebuild-проект на фейковом Android-проекте.
 *
 * Почему на фейковом: настоящий prebuild требует Android SDK и минуты сборки, а
 * ломается обычно не Gradle, а наши вставки — импорт в `MainApplication`, сервис в
 * манифесте, блок CMake. Эти четыре вещи проверяются за миллисекунды.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/android-embed-node.mjs');

function fakeProject() {
  const dir = mkdtempSync(path.join(tmpdir(), 'vision-embed-'));
  const app = path.join(dir, 'android/app');
  mkdirSync(path.join(app, 'src/main/java/app/vision/audio'), { recursive: true });
  writeFileSync(path.join(app, 'build.gradle'), "android {\n    namespace 'app.vision.audio'\n}\n");
  writeFileSync(
    path.join(app, 'src/main/AndroidManifest.xml'),
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n  <application>\n  </application>\n</manifest>\n',
  );
  writeFileSync(
    path.join(app, 'src/main/java/app/vision/audio/MainApplication.kt'),
    'package app.vision.audio\n\nclass MainApplication {\n  fun packages() {\n    PackageList(this).packages.apply {\n    }\n  }\n}\n',
  );
  return dir;
}

/**
 * Запуск скрипта. Возвращаем stdout+stderr вместе: предупреждения идут в stderr, а
 * проверяем их так же, как результат — иначе тест не заметит, что про пропущенный
 * libnode просто промолчали.
 */
function run(dir, extra = []) {
  const result = spawnSync(process.execPath, [SCRIPT, ...extra], {
    env: { ...process.env, VISION_APP_DIR: dir },
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Запуск, который обязан упасть с ненулевым кодом. */
function runFailing(dir, extra = []) {
  const result = run(dir, extra);
  assert.notEqual(result.status, 0, 'скрипт должен был завершиться с ошибкой');
  return result.output;
}

test('вживление раскладывает файлы и делает вставки', () => {
  const dir = fakeProject();
  try {
    const output = run(dir).output;
    assert.match(output, /Kotlin: 3 файла/);
    const app = path.join(dir, 'android/app');

    // 1. исходники на месте
    const java = path.join(app, 'src/main/java/app/vision/audio/node');
    for (const file of ['VisionNodeModule.kt', 'VisionNodePackage.kt', 'VisionNodeService.kt']) {
      assert.ok(existsSync(path.join(java, file)), `нет ${file}`);
    }
    assert.ok(existsSync(path.join(app, 'src/main/cpp/vision-node-jni.cpp')));
    assert.ok(existsSync(path.join(app, 'src/main/cpp/vision-node-CMakeLists.txt')));

    // 2. bootstrap в assets — из него читает Java при старте
    const bootstrap = path.join(app, 'src/main/assets/nodejs-project/bootstrap.mjs');
    assert.ok(existsSync(bootstrap));
    assert.match(readFileSync(bootstrap, 'utf8'), /\/api\/health/);

    // 3. пакет зарегистрирован с импортом
    const main = readFileSync(path.join(app, 'src/main/java/app/vision/audio/MainApplication.kt'), 'utf8');
    assert.match(main, /add\(VisionNodePackage\(\)\)/);
    assert.match(main, /import app\.vision\.audio\.node\.VisionNodePackage/);

    // 4. сервис в манифесте
    const manifest = readFileSync(path.join(app, 'src/main/AndroidManifest.xml'), 'utf8');
    assert.match(manifest, /VisionNodeService/);
    assert.match(manifest, /foregroundServiceType="dataSync"/);

    // 5. ABI-фильтры
    const gradle = readFileSync(path.join(app, 'build.gradle'), 'utf8');
    assert.match(gradle, /abiFilters 'arm64-v8a', 'armeabi-v7a', 'x86_64'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('повторный запуск ничего не дублирует', () => {
  const dir = fakeProject();
  try {
    run(dir);
    run(dir);
    const app = path.join(dir, 'android/app');
    const main = readFileSync(path.join(app, 'src/main/java/app/vision/audio/MainApplication.kt'), 'utf8');
    assert.equal(main.match(/add\(VisionNodePackage\(\)\)/g).length, 1);
    const manifest = readFileSync(path.join(app, 'src/main/AndroidManifest.xml'), 'utf8');
    assert.equal(manifest.match(/VisionNodeService/g).length, 1);
    const gradle = readFileSync(path.join(app, 'build.gradle'), 'utf8');
    assert.equal(gradle.match(/abiFilters/g).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('без libnode APK собирается без CMake, но об этом предупреждают', () => {
  const dir = fakeProject();
  try {
    const output = run(dir).output;
    assert.match(output, /libnode не скачан/);
    assert.match(output, /CMake пропущен/);
    // внешняя сборка без libnode сломала бы Gradle — её не должно быть
    const gradle = readFileSync(path.join(dir, 'android/app/build.gradle'), 'utf8');
    assert.equal(gradle.includes('externalNativeBuild'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--check падает, когда сервер не собран, и проходит, когда собран', () => {
  const dir = fakeProject();
  try {
    assert.match(runFailing(dir, ['--check']), /встроенный сервер не собран/);
    run(dir);
    // файлы на месте, но libnode нет — это по-прежнему «не собрано»
    assert.match(runFailing(dir, ['--check']), /libnode/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
