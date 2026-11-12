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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, cpSync } from 'node:fs';
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
    path.join(dir, 'android/gradle.properties'),
    'org.gradle.jvmargs=-Xmx2048m\nreactNativeArchitectures=armeabi-v7a,arm64-v8a,x86,x86_64\n',
  );
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
function run(dir, extra = [], env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...extra], {
    env: { ...process.env, VISION_APP_DIR: dir, ...env },
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
    // AGP принимает только файл с именем CMakeLists.txt — это ломало сборку
    const cmake = path.join(app, 'src/main/cpp/visionnode/CMakeLists.txt');
    assert.ok(existsSync(cmake), 'CMakeLists.txt должен лежать в src/main/cpp/visionnode/');
    const cmakeText = readFileSync(cmake, 'utf8');
    assert.match(cmakeText, /vision-node-jni\.cpp/);
    // node.h подключает uv.h/v8*.h относительными путями → нужен include/node
    assert.match(cmakeText, /libnode\/include\/node/);
    // Node 24 без C++20 не компилируется (v8config.h: «C++20 or later required»)
    assert.match(cmakeText, /CMAKE_CXX_STANDARD 20/);

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

    // 5. ABI — в gradle.properties, а не в DSL: только по этому списку Gradle
    // создаёт задачи CMake (под x86 libnode.so нет)
    const props = readFileSync(path.join(dir, 'android/gradle.properties'), 'utf8');
    assert.match(props, /^reactNativeArchitectures=arm64-v8a$/m);
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
    const props = readFileSync(path.join(dir, 'android/gradle.properties'), 'utf8');
    assert.equal(props.match(/^reactNativeArchitectures=/gm).length, 1);
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

test('с скачанным libnode подключается CMake с абсолютным путём к рантайму', () => {
  const dir = fakeProject();
  // Копия исходников во временном каталоге + фальшивый libnode: проверяем именно
  // ветку «рантайм есть», не скачивая 90 МБ.
  const src = mkdtempSync(path.join(tmpdir(), 'vision-nodesrc-'));
  try {
    cpSync(path.join(ROOT, 'apps/mobile/nodejs/android'), src, {
      recursive: true,
      filter: (from) => !from.includes(`${path.sep}libnode`),
    });
    mkdirSync(path.join(src, 'libnode/include/node'), { recursive: true });
    writeFileSync(path.join(src, 'libnode/include/node/node.h'), '// stub\n');
    for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86_64']) {
      mkdirSync(path.join(src, 'libnode/bin', abi), { recursive: true });
      writeFileSync(path.join(src, 'libnode/bin', abi, 'libnode.so'), 'stub');
    }

    const output = run(dir, [], { VISION_NODE_SRC: src }).output;
    assert.match(output, /внешняя сборка CMake/);

    const gradle = readFileSync(path.join(dir, 'android/app/build.gradle'), 'utf8');
    // AGP: только файл с именем CMakeLists.txt
    assert.match(gradle, /path "src\/main\/cpp\/visionnode\/CMakeLists\.txt"/);
    // ABI живут только в gradle.properties: `ndk.abiFilters` фильтрует упаковку, но
    // не мешает Gradle создавать задачи CMake под x86 (нет libnode.so), а
    // `cmake { abiFilters }` в AGP не существует.
    assert.equal(gradle.includes('abiFilters'), false);

    const props = readFileSync(path.join(dir, 'android/gradle.properties'), 'utf8');
    // По умолчанию только arm64-v8a: каждый ABI — это +60 МБ libnode.so в APK.
    assert.match(props, /^reactNativeArchitectures=arm64-v8a$/m);
    assert.equal(props.includes('x86'), false);
    assert.match(gradle, new RegExp(`arguments "-DVISION_NODE_DIR=${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));

    // --check теперь проходит: рантайм, мост, сервис и bootstrap на месте
    assert.equal(run(dir, ['--check'], { VISION_NODE_SRC: src }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test('VISION_ABIS расширяет список ABI, когда нужны старые телефоны и эмулятор', () => {
  const dir = fakeProject();
  try {
    run(dir, [], { VISION_ABIS: 'arm64-v8a,armeabi-v7a' });
    const props = readFileSync(path.join(dir, 'android/gradle.properties'), 'utf8');
    assert.match(props, /^reactNativeArchitectures=arm64-v8a,armeabi-v7a$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
