#!/usr/bin/env node
/**
 * Готовит сгенерированный `expo prebuild` Android-проект к релизной сборке.
 *
 *   node scripts/android-prepare.mjs          # из корня репозитория
 *
 * Что делает:
 *  1. проставляет versionCode/versionName (versionCode — из GITHUB_RUN_NUMBER,
 *     чтобы Android видел обновления);
 *  2. подключает signingConfig `visionRelease` к release-сборке;
 *  3. проверяет, что release-манифест разрешает HTTP (`usesCleartextTraffic`) —
 *     иначе телефон не достучится до домашнего сервера по `http://<ip>:4000`.
 *
 * Ключ: `apps/mobile/vision-release.p12` (PKCS#12, самоподписанный). Пароль по
 * умолчанию — `vision-audio`; переопределяется переменными окружения
 * VISION_KEYSTORE_PATH / VISION_KEYSTORE_PASSWORD / VISION_KEY_ALIAS / VISION_KEY_PASSWORD.
 * Подробности и оговорки — docs/ANDROID.md.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.resolve(process.env.VISION_APP_DIR || path.join(ROOT, 'apps/mobile'));
const GRADLE = path.join(APP_DIR, 'android/app/build.gradle');
const MANIFEST = path.join(APP_DIR, 'android/app/src/main/AndroidManifest.xml');
const APP_JSON = path.join(APP_DIR, 'app.json');

if (!existsSync(GRADLE)) {
  console.error(`✖ Не найден ${path.relative(ROOT, GRADLE)} — сначала выполните: npx expo prebuild --platform android`);
  process.exit(1);
}

const appConfig = JSON.parse(readFileSync(APP_JSON, 'utf8'));
const versionName = String(appConfig?.expo?.version ?? '0.0.0');
const versionCode = Number(process.env.VISION_VERSION_CODE || process.env.GITHUB_RUN_NUMBER || 1) || 1;

// --- 1. версия -------------------------------------------------------------
let gradle = readFileSync(GRADLE, 'utf8');

if (!/versionCode\s+\d+/.test(gradle) || !/versionName\s+"[^"]*"/.test(gradle)) {
  console.error('✖ В build.gradle не нашлись versionCode/versionName — шаблон Expo изменился');
  process.exit(1);
}

gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${versionName}"`);

// --- 2. подпись ------------------------------------------------------------
const MARKER = '// vision-signing';
if (gradle.includes(MARKER)) {
  // повторный запуск: убираем старый блок, чтобы не дублировать конфигурацию
  gradle = gradle.replace(new RegExp(`\\n${MARKER}[\\s\\S]*?\\n// vision-signing-end\\n`, 'g'), '\n');
}

gradle += `
${MARKER}
android {
    signingConfigs {
        visionRelease {
            storeFile file(System.getenv("VISION_KEYSTORE_PATH") ?: "../vision-release.p12")
            storeType "PKCS12"
            storePassword System.getenv("VISION_KEYSTORE_PASSWORD") ?: "vision-audio"
            keyAlias System.getenv("VISION_KEY_ALIAS") ?: "vision"
            keyPassword System.getenv("VISION_KEY_PASSWORD") ?: "vision-audio"
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.visionRelease
        }
    }
}
// vision-signing-end
`;

writeFileSync(GRADLE, gradle);

// --- 2b. память Gradle: сборка с new architecture (C++/CMake на 4 ABI) ---
const GRADLE_PROPS = path.join(APP_DIR, 'android/gradle.properties');
if (existsSync(GRADLE_PROPS)) {
  let props = readFileSync(GRADLE_PROPS, 'utf8');
  const jvmArgs = '-Xmx4g -XX:MaxMetaspaceSize=1g -Dfile.encoding=UTF-8';
  if (/^org\.gradle\.jvmargs=.*$/m.test(props)) {
    props = props.replace(/^org\.gradle\.jvmargs=.*$/m, `org.gradle.jvmargs=${jvmArgs}`);
  } else {
    props += `\norg.gradle.jvmargs=${jvmArgs}\n`;
  }
  if (!/^kotlin\.daemon\.jvmargs=/m.test(props)) {
    props += 'kotlin.daemon.jvmargs=-Xmx3g\n';
  }
  writeFileSync(GRADLE_PROPS, props);
}

const keystore = path.resolve(process.env.VISION_KEYSTORE_PATH || path.join(APP_DIR, 'vision-release.p12'));
if (!existsSync(keystore)) {
  console.error(`✖ Не найден ключ подписи ${keystore} (docs/ANDROID.md)`);
  process.exit(1);
}

// --- 3. HTTP до домашнего сервера -----------------------------------------
if (!existsSync(MANIFEST)) {
  console.error(`✖ Не найден ${path.relative(ROOT, MANIFEST)}`);
  process.exit(1);
}

let manifest = readFileSync(MANIFEST, 'utf8');
if (!/android:usesCleartextTraffic="true"/.test(manifest)) {
  // плагин expo-build-properties должен был добавить атрибут; если он этого не
  // сделал — правим манифест сами, иначе release-сборка блокирует http://
  manifest = manifest.replace(/<application\b/, '<application android:usesCleartextTraffic="true"');
  writeFileSync(MANIFEST, manifest);
  console.log('⚠ usesCleartextTraffic добавлен вручную (плагин expo-build-properties не сработал)');
}

console.log(`✓ build.gradle: versionName ${versionName}, versionCode ${versionCode}`);
console.log(`✓ подпись: ${path.relative(ROOT, keystore)} (alias ${process.env.VISION_KEY_ALIAS || 'vision'})`);
console.log('✓ манифест: usesCleartextTraffic=true (http:// до домашнего сервера)');
