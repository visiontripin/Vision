#!/usr/bin/env node
/**
 * Готовит сгенерированный `tauri android init` проект админки к релизной сборке.
 *
 *   node scripts/android-sign-console.mjs        # из корня репозитория
 *
 * Зачем: `tauri android build --apk` собирает **release**-APK, а release-сборка
 * без `signingConfig` остаётся неподписанной. Android такие файлы не ставит —
 * на телефоне это выглядит как «Приложение не установлено: пакет недействителен
 * (например, повреждён)». Именно так и уехал в релиз `app-universal-release-unsigned.apk`.
 *
 * Что делает скрипт:
 *  1. проставляет versionCode/versionName (versionCode — из GITHUB_RUN_NUMBER,
 *     чтобы Android видел обновления поверх старой сборки);
 *  2. подключает signingConfig `visionRelease` с тем же ключом, что у мобильного
 *     приложения (`apps/mobile/vision-release.p12`), — один ключ на все свои APK;
 *  3. проверяет, что подпись действительно попала в build.gradle, и падает,
 *     если шаблон Gradle изменился (иначе APK снова уедет без подписи).
 *
 * Ключ и пароль те же, что в `scripts/android-prepare.mjs` и `docs/ANDROID.md`:
 * репозиторий личный, сборка должна воспроизводиться без секретов. Переопределяется
 * переменными VISION_KEYSTORE_PATH / VISION_KEYSTORE_PASSWORD / VISION_KEY_ALIAS /
 * VISION_KEY_PASSWORD.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.resolve(process.env.VISION_CONSOLE_DIR || path.join(ROOT, 'apps/console'));
const GRADLE = path.join(APP_DIR, 'src-tauri/gen/android/app/build.gradle.kts');
const KEYSTORE = path.resolve(
  process.env.VISION_KEYSTORE_PATH || path.join(ROOT, 'apps/mobile/vision-release.p12')
);

if (!existsSync(GRADLE)) {
  console.error(
    `✖ Не найден ${path.relative(ROOT, GRADLE)} — сначала выполните: cd apps/console && npx tauri android init`
  );
  process.exit(1);
}
if (!existsSync(KEYSTORE)) {
  console.error(`✖ Не найден ключ подписи ${KEYSTORE} (docs/ANDROID.md)`);
  process.exit(1);
}

const versionName = JSON.parse(
  readFileSync(path.join(APP_DIR, 'src-tauri/tauri.conf.json'), 'utf8')
).version;
const versionCode =
  Number(process.env.VISION_VERSION_CODE || process.env.GITHUB_RUN_NUMBER || 1) || 1;

let gradle = readFileSync(GRADLE, 'utf8');

// --- 1. версия -------------------------------------------------------------
/*
 * В Tauri 2.12 `app/build.gradle.kts` не содержит versionCode/versionName —
 * плагин Tauri берёт их из `tauri.conf.json` (`version`) и из `--config`
 * (`bundle.android.versionCode`). Поэтому версию пишем в конфиг, а Gradle
 * трогаем только если он действительно генерирует эти поля (старые шаблоны).
 */
const configPath = path.join(APP_DIR, 'src-tauri/tauri.conf.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const previousCode = config.bundle?.android?.versionCode;
if (previousCode !== versionCode) {
  config.bundle = config.bundle || {};
  config.bundle.android = { ...(config.bundle.android || {}), versionCode };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

const gradleWritesVersion = /version(Name|Code)\s*=?\s*"?\d/.test(gradle);
if (gradleWritesVersion) {
  gradle = /versionCode\s*=\s*\d+/.test(gradle)
    ? gradle.replace(/versionCode\s*=\s*\d+/, `versionCode = ${versionCode}`)
    : gradle;
  gradle = /versionCode\s+\d+/.test(gradle)
    ? gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
    : gradle;
  gradle = /versionName\s*=\s*"[^"]*"/.test(gradle)
    ? gradle.replace(/versionName\s*=\s*"[^"]*"/, `versionName = "${versionName}"`)
    : gradle.replace(/versionName\s+"[^"]*"/, `versionName "${versionName}"`);
  console.log('· версия продублирована в build.gradle.kts (шаблон со своими полями)');
} else {
  console.log('· версия берётся из tauri.conf.json + bundle.android.versionCode (Tauri 2.12)');
}

// --- 2. подпись ------------------------------------------------------------
const MARKER = '// vision-signing';
if (gradle.includes(MARKER)) {
  // повторный запуск: убираем старый блок, чтобы не дублировать конфигурацию
  gradle = gradle.replace(
    new RegExp(`\\n?${MARKER}[\\s\\S]*?\\n// vision-signing-end\\n`, 'g'),
    '\n'
  );
}

/*
 * Абсолютный путь к ключу подставляем по умолчанию (в CI ключ лежит в
 * `apps/mobile`), переменная окружения его переопределяет.
 *
 * Важно: импорты в `build.gradle.kts` пишутся только в начале файла, а мы
 * дописываем блок в конец — поэтому `java.io.File` не импортируем, а берём
 * `file(...)` из Project: он возвращает тот же `File` без импорта.
 */
gradle += `
${MARKER}
android {
    signingConfigs {
        create("visionRelease") {
            storeFile = file(
                System.getenv("VISION_KEYSTORE_PATH")
                    ?: "${KEYSTORE.replace(/\\/g, '/')}"
            )
            storeType = "PKCS12"
            storePassword = System.getenv("VISION_KEYSTORE_PASSWORD") ?: "vision-audio"
            keyAlias = System.getenv("VISION_KEY_ALIAS") ?: "vision"
            keyPassword = System.getenv("VISION_KEY_PASSWORD") ?: "vision-audio"
        }
    }
    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("visionRelease")
        }
    }
}
// vision-signing-end
`;

writeFileSync(GRADLE, gradle);

// --- 3. самопроверка -------------------------------------------------------
const result = readFileSync(GRADLE, 'utf8');
const checks = [
  [/signingConfigs\s*\{/, 'нет блока signingConfigs'],
  [/create\("visionRelease"\)/, 'нет конфигурации visionRelease'],
  [/buildTypes\s*\{[\s\S]*getByName\("release"\)[\s\S]*signingConfig/, 'release не использует подпись'],
];
const failed = checks.filter(([re]) => !re.test(result)).map(([, message]) => message);
if (failed.length) {
  console.error(`✖ Подпись не подключилась: ${failed.join('; ')}`);
  process.exit(1);
}

const savedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
if (savedConfig.version !== versionName || savedConfig.bundle?.android?.versionCode !== versionCode) {
  console.error('✖ Версия не записалась в tauri.conf.json');
  process.exit(1);
}

console.log(`✓ tauri.conf.json: version ${versionName}, bundle.android.versionCode ${versionCode}`);
console.log(`✓ подпись: ${path.relative(ROOT, KEYSTORE)} (alias ${process.env.VISION_KEY_ALIAS || 'vision'})`);
console.log('✓ release-сборка APK подписана — Android не отвергнет пакет');
