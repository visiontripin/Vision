#!/usr/bin/env node
/**
 * Переключает `apps/mobile/app.json` в режим тестового приложения.
 *
 *   node scripts/android-tester-app.mjs            # VisionTester (applicationId …tester)
 *   node scripts/android-tester-app.mjs --restore   # вернуть обычное приложение
 *
 * Зачем отдельный applicationId: тестовый APK должен ставиться **рядом** с
 * обычным. С тем же id Android не даст установить его без удаления основного
 * приложения вместе с библиотекой и входом — то есть проверка новой сборки
 * стоила бы пользователю его музыки.
 *
 * Что меняется:
 *  - `android.package` → `app.vision.audio.tester`;
 *  - `name` → `Vision Audio Tester` (видно в списке приложений);
 *  - `scheme` → `visiontester`, чтобы ссылки не открывали оба приложения разом;
 *  - `versionCode` — из `GITHUB_RUN_NUMBER`, как у релизной сборки.
 *
 * Файл `app.json` после сборки восстанавливается из резервной копии
 * (`app.json.vision-backup`), чтобы в git не уехала тестовая конфигурация.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_JSON = path.resolve(process.env.VISION_APP_DIR || path.join(ROOT, 'apps/mobile'), 'app.json');
const BACKUP = `${APP_JSON}.vision-backup`;
const TESTER_ID = 'app.vision.audio.tester';

if (!existsSync(APP_JSON)) {
  console.error(`✖ не найден ${APP_JSON}`);
  process.exit(1);
}

if (process.argv.includes('--restore')) {
  if (existsSync(BACKUP)) {
    copyFileSync(BACKUP, APP_JSON);
    rmSync(BACKUP, { force: true });
    console.log('• app.json восстановлен');
  } else {
    console.log('• резервной копии нет — восстанавливать нечего');
  }
  process.exit(0);
}

const config = JSON.parse(readFileSync(APP_JSON, 'utf8'));
const expo = config.expo ?? {};

if (expo.android?.package !== TESTER_ID) {
  // Копию делаем только один раз: повторный запуск не должен затереть оригинал
  // уже тестовой конфигурацией.
  if (!existsSync(BACKUP)) copyFileSync(APP_JSON, BACKUP);
}

expo.name = 'Vision Audio Tester';
expo.scheme = 'visiontester';
expo.android = { ...(expo.android ?? {}), package: TESTER_ID };
expo.android.versionCode = Number(process.env.GITHUB_RUN_NUMBER || expo.android.versionCode || 1) || 1;
// Меняем и явный intent-filter, не только expo.scheme: иначе обе установки
// регистрируются на `visionaudio` и тестовая сборка перехватывает ссылки плеера.
if (Array.isArray(expo.android.intentFilters)) {
  expo.android.intentFilters = expo.android.intentFilters.map((filter) => ({
    ...filter,
    ...(Array.isArray(filter.data)
      ? { data: filter.data.map((item) => item.scheme === 'visionaudio' ? { ...item, scheme: 'visiontester' } : item) }
      : {}),
  }));
}

// Минимальные права для сети и foreground-сервиса, в котором работает Node.
// Доступ к медиатеке и уведомлениям плеера тестеру не нужен.
expo.android.permissions = ['INTERNET', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_DATA_SYNC'];

config.expo = expo;
writeFileSync(APP_JSON, `${JSON.stringify(config, null, 2)}\n`);

console.log(`• app.json: ${expo.name} (${TESTER_ID}), versionCode ${expo.android.versionCode}`);
console.log(`• резервная копия: ${path.basename(BACKUP)}`);
