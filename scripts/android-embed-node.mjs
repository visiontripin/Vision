#!/usr/bin/env node
/**
 * Вживляет Node-рантайм в сгенерированный `expo prebuild` Android-проект.
 *
 *   npx expo prebuild -p android --no-install
 *   node scripts/fetch-nodejs-mobile.mjs                 # один раз, ≈90 МБ
 *   node scripts/android-prepare.mjs                     # версия и подпись
 *   node scripts/android-embed-node.mjs                  # ← этот скрипт
 *   cd apps/mobile/android && ./gradlew assembleRelease
 *
 * Что делает (ничего не удаляя и не перезаписывая чужое):
 *
 *  1. копирует Kotlin-модуль, сервис и C++-мост в `android/app/src/main/...`;
 *  2. кладёт `bootstrap.mjs` в `assets/nodejs-project/`;
 *  3. добавляет `externalNativeBuild`/`ndk.abiFilters` в `app/build.gradle`;
 *  4. регистрирует `VisionNodePackage` в `MainApplication.kt`;
 *  5. дописывает сервис в `AndroidManifest.xml`.
 *
 * Идемпотентен: повторный запуск не дублирует блоки (метки `vision-node`).
 *
 * `--check` только проверяет, что всё на месте — используется в CI, чтобы разница
 * между «сборка без Node» и «сборка с Node» была видна в логе, а не в поведении
 * приложения.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE = path.join(ROOT, 'apps/mobile');
const APP_DIR = path.resolve(process.env.VISION_APP_DIR || MOBILE);
const ANDROID = path.join(APP_DIR, 'android');
// VISION_NODE_SRC — только для тестов: подменяет каталог с мостом и libnode.
const SRC = path.resolve(process.env.VISION_NODE_SRC || path.join(MOBILE, 'nodejs/android'));
const CHECK_ONLY = process.argv.includes('--check');
const MARK = '// vision-node';

const log = (message) => console.log(`• ${message}`);
const warn = (message) => console.warn(`⚠ ${message}`);
const fail = (message) => {
  console.error(`✖ ${message}`);
  process.exit(1);
};

if (!existsSync(ANDROID)) {
  fail(`нет ${path.relative(ROOT, ANDROID)} — сначала: npx expo prebuild --platform android --no-install`);
}

const libnode = path.join(SRC, 'libnode');
const hasLibnode = existsSync(path.join(libnode, 'include', 'node', 'node.h'));
const JAVA_SRC = path.join(SRC, 'java/app/vision/audio/node');
const GRADLE = path.join(ANDROID, 'app/build.gradle');
const MANIFEST = path.join(ANDROID, 'app/src/main/AndroidManifest.xml');
const MAIN_APP = [
  path.join(ANDROID, 'app/src/main/java/app/vision/audio/MainApplication.kt'),
  path.join(ANDROID, 'app/src/main/java/app/vision/audio/MainApplication.java'),
].find((file) => existsSync(file));

if (CHECK_ONLY) {
  const problems = [];
  if (!hasLibnode) problems.push('нет libnode (node scripts/fetch-nodejs-mobile.mjs)');
  if (!existsSync(GRADLE) || !readFileSync(GRADLE, 'utf8').includes(MARK)) problems.push('build.gradle без внешней сборки');
  if (!MAIN_APP || !readFileSync(MAIN_APP, 'utf8').includes('VisionNodePackage')) problems.push('VisionNodePackage не зарегистрирован');
  if (!existsSync(MANIFEST) || !readFileSync(MANIFEST, 'utf8').includes('VisionNodeService')) problems.push('сервис не в манифесте');
  if (!existsSync(path.join(ANDROID, 'app/src/main/assets/nodejs-project/bootstrap.mjs'))) problems.push('нет bootstrap.mjs в assets');
  if (problems.length) fail(`встроенный сервер не собран: ${problems.join('; ')}`);
  log('встроенный сервер собран: рантайм, мост, сервис и bootstrap на месте');
  process.exit(0);
}

if (!hasLibnode) {
  // Не молчим: сборка без рантайма даёт APK, где кнопка «Запустить сервер» честно
  // скажет «нет рантайма». Это допустимый режим, но не то, чего ждут от «A».
  warn('libnode не скачан — APK соберётся без Node (экраны и тестер будут, сервер скажет «недоступен»)');
  warn('чтобы включить сервер: node scripts/fetch-nodejs-mobile.mjs');
}

// --- 1. исходники ----------------------------------------------------------
const JAVA_DST = path.join(ANDROID, 'app/src/main/java/app/vision/audio/node');
mkdirSync(JAVA_DST, { recursive: true });
for (const file of readdirSync(JAVA_SRC)) {
  cpSync(path.join(JAVA_SRC, file), path.join(JAVA_DST, file));
}
log(`Kotlin: ${readdirSync(JAVA_SRC).length} файла в app/vision/audio/node`);

// AGP требует ровно `CMakeLists.txt` — кладём его в подкаталог, чтобы не
// конфликтовать с другими нативными сборками проекта.
const cppDst = path.join(ANDROID, 'app/src/main/cpp/visionnode');
mkdirSync(cppDst, { recursive: true });
cpSync(path.join(SRC, 'CMakeLists.txt'), path.join(cppDst, 'CMakeLists.txt'));

// --- 2. bootstrap.mjs в assets --------------------------------------------
const assets = path.join(ANDROID, 'app/src/main/assets/nodejs-project');
mkdirSync(assets, { recursive: true });
const bootstrapSrc = path.join(MOBILE, 'nodejs/embedded/bootstrap.mjs');
cpSync(bootstrapSrc, path.join(assets, 'bootstrap.mjs'));
writeFileSync(path.join(assets, 'package.json'), JSON.stringify({ name: 'vision-embedded', type: 'module', private: true }, null, 2));
log(`assets: bootstrap.mjs (${(statSync(bootstrapSrc).size / 1024).toFixed(1)} КБ)`);

// --- 3. build.gradle -------------------------------------------------------
let gradle = readFileSync(GRADLE, 'utf8');
// Убираем прошлые вставки (повторный prebuild/повторный запуск): тело метки
// заменяем пустой строкой, чтобы блок не задвоился.
function stripBlock(text, name) {
  const pattern = new RegExp('\\s*' + MARK + ':' + name + '[\\s\\S]*?' + MARK + ':' + name + '-end\\s*', 'g');
  return text.replace(pattern, '\n');
}

gradle = stripBlock(gradle, 'native');
gradle = stripBlock(gradle, 'abi');

const abiBlock = `
${MARK}:abi
android {
    defaultConfig {
        ndk {
            // Три ABI: arm64 — телефоны, armeabi-v7a — старые устройства, x86_64 — эмулятор.
            abiFilters 'arm64-v8a', 'armeabi-v7a', 'x86_64'
        }
    }
    packagingOptions {
        jniLibs {
            // libnode.so грузится из APK: сжатие ломает dlopen на части устройств.
            useLegacyPackaging = false
        }
    }
}
${MARK}:abi-end
`;
gradle += abiBlock;

if (hasLibnode) {
  gradle += `
${MARK}:native
android {
    externalNativeBuild {
        cmake {
            path "src/main/cpp/visionnode/CMakeLists.txt"
            version "3.22.1"
        }
    }
    defaultConfig {
        externalNativeBuild {
            cmake {
                // Абсолютный путь: исходник моста и рантайм лежат в репозитории,
                // а не в сгенерированном каталоге Android-проекта.
                arguments "-DVISION_NODE_DIR=${SRC}"
            }
        }
    }
}
${MARK}:native-end
`;
}
writeFileSync(GRADLE, gradle);
log(`build.gradle: ABI ${hasLibnode ? 'и внешняя сборка CMake' : '(CMake пропущен — нет libnode)'}`);

// --- 4. регистрация пакета -------------------------------------------------
if (!MAIN_APP) {
  fail('не нашёл MainApplication.kt/java — Expo изменил шаблон, зарегистрируйте VisionNodePackage вручную');
}
let mainApp = readFileSync(MAIN_APP, 'utf8');
if (!mainApp.includes('VisionNodePackage')) {
  if (mainApp.includes('PackageList(this).packages.apply {')) {
    mainApp = mainApp.replace(
      'PackageList(this).packages.apply {',
      'PackageList(this).packages.apply {\n            // vision-node\n            add(VisionNodePackage())',
    );
  } else if (mainApp.includes('return packages')) {
    // Java-шаблон
    mainApp = mainApp.replace('return packages', 'packages.add(new VisionNodePackage()); // vision-node\n      return packages');
  } else {
    fail(`не смог вставить VisionNodePackage в ${path.basename(MAIN_APP)} — шаблон Expo изменился`);
  }
  if (!mainApp.includes('import app.vision.audio.node.VisionNodePackage')) {
    mainApp = mainApp.replace(/^(package .*\n)/m, '$1\nimport app.vision.audio.node.VisionNodePackage\n');
  }
  writeFileSync(MAIN_APP, mainApp);
  log(`MainApplication: добавлен VisionNodePackage`);
} else {
  log('MainApplication: VisionNodePackage уже зарегистрирован');
}

// --- 5. манифест -----------------------------------------------------------
let manifest = readFileSync(MANIFEST, 'utf8');
if (!manifest.includes('VisionNodeService')) {
  const service = `
    <!-- vision-node: сервер на телефоне держится foreground-сервисом -->
    <service
        android:name=".node.VisionNodeService"
        android:exported="false"
        android:foregroundServiceType="dataSync" />
`;
  manifest = manifest.replace('</application>', `${service}  </application>`);
  writeFileSync(MANIFEST, manifest);
  log('AndroidManifest: сервис добавлен');
} else {
  log('AndroidManifest: сервис уже есть');
}

const size = hasLibnode
  ? libnodeSize(libnode)
  : 0;
log(`готово${size ? `, libnode.so ≈ ${(size / 1048576).toFixed(0)} МБ на 3 ABI` : ''}`);

function libnodeSize(dir) {
  let total = 0;
  for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86_64']) {
    const file = path.join(dir, 'bin', abi, 'libnode.so');
    if (existsSync(file)) total += statSync(file).size;
  }
  return total;
}
