#!/usr/bin/env node
/**
 * Скачивает Node-рантайм для Android (nodejs-mobile) и раскладывает его так, как
 * ожидает CMake: `nodejs/android/libnode/include/node/*.h` и
 * `nodejs/android/libnode/bin/<abi>/libnode.so`.
 *
 *   node scripts/fetch-nodejs-mobile.mjs            # скачать (≈90 МБ)
 *   node scripts/fetch-nodejs-mobile.mjs --check    # только проверить наличие
 *   NODE_MOBILE_CACHE=/path node scripts/fetch...   # свой кэш архивов
 *
 * Версию и URL берём из `apps/mobile/nodejs/android/node-version.json` — одна
 * точка правды, чтобы CI и локальная сборка не разъехались.
 *
 * Почему не npm-пакет `nodejs-mobile-react-native`: там Node 18, а серверу нужен
 * `node:sqlite` (Node 22.5+). Здесь берём сборку под Node 24 с 16 КБ страницами
 * памяти (требование Android 15+).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_DIR = path.join(ROOT, 'apps/mobile/nodejs/android');
const LIBNODE = path.join(ANDROID_DIR, 'libnode');
const MANIFEST = JSON.parse(readFileSync(path.join(ANDROID_DIR, 'node-version.json'), 'utf8'));
const CHECK_ONLY = process.argv.includes('--check');
const CACHE_DIR = process.env.NODE_MOBILE_CACHE || path.join(ROOT, '.node-mobile-cache');

const info = (message) => console.log(`• ${message}`);
const fail = (message) => {
  console.error(`✖ ${message}`);
  process.exit(1);
};

function hasRuntime() {
  return MANIFEST.abi.every((abi) => existsSync(path.join(LIBNODE, 'bin', abi, 'libnode.so')))
    && existsSync(path.join(LIBNODE, 'include', 'node', 'node.h'));
}

if (CHECK_ONLY) {
  if (hasRuntime()) {
    info(`рантайм на месте: Node ${MANIFEST.node} (${MANIFEST.abi.join(', ')})`);
    process.exit(0);
  }
  fail(`нет рантайма в ${path.relative(ROOT, LIBNODE)} — выполните node scripts/fetch-nodejs-mobile.mjs`);
}

if (hasRuntime()) {
  info(`уже скачано: Node ${MANIFEST.node}`);
  process.exit(0);
}

mkdirSync(CACHE_DIR, { recursive: true });
const archive = path.join(CACHE_DIR, MANIFEST.asset);

if (!existsSync(archive) || statSync(archive).size < 10_000_000) {
  info(`скачиваю ${MANIFEST.asset} (${MANIFEST.source}, Node ${MANIFEST.node})…`);
  // curl, а не fetch: 90 МБ через undici в CI медленно и падает на таймаутах
  try {
    execFileSync('curl', ['-fL', '--retry', '3', '--retry-delay', '2', '--max-time', '600', '-o', archive, MANIFEST.url], {
      stdio: 'inherit',
    });
  } catch {
    fail(`не удалось скачать ${MANIFEST.url}. Проверьте сеть или положите архив в ${CACHE_DIR}`);
  }
} else {
  info(`беру из кэша: ${path.relative(ROOT, archive)}`);
}

const size = statSync(archive).size;
if (size < 10_000_000) fail(`архив подозрительно мал (${size} Б) — скачивание не удалось`);

// Распаковываем целиком и переносим только нужное. Раньше здесь была фильтрация
// имён и `unzip … <3000 аргументов>`: на CI это упирается в лимит длины командной
// строки и падает с невнятной ошибкой. Полная распаковка 90 МБ дешевле и надёжнее.
info('распаковываю…');
rmSync(LIBNODE, { recursive: true, force: true });
mkdirSync(LIBNODE, { recursive: true });
const raw = path.join(LIBNODE, '_raw');
mkdirSync(raw, { recursive: true });

try {
  execFileSync('unzip', ['-q', '-o', archive, '-d', raw], { stdio: 'inherit' });
} catch (error) {
  const entries = (() => {
    try {
      return execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).split('\n').slice(0, 20);
    } catch {
      return ['(не удалось прочитать архив)'];
    }
  })();
  fail(`unzip не справился с ${MANIFEST.asset}: ${error?.message ?? error}\nпервые записи архива:\n${entries.join('\n')}`);
}

/** В архиве бывает обёртка вида `nodejs-mobile-vX-android/` — спускаемся до неё. */
function findRoot(dir, depth = 0) {
  if (depth > 3) return dir;
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.some((entry) => entry.isDirectory() && (entry.name === 'include' || entry.name === 'bin'))) return dir;
  const nested = entries.find((entry) => entry.isDirectory());
  return nested ? findRoot(path.join(dir, nested.name), depth + 1) : dir;
}

const base = findRoot(raw);
for (const part of ['include', 'bin']) {
  if (existsSync(path.join(base, part))) cpSync(path.join(base, part), path.join(LIBNODE, part), { recursive: true });
}
rmSync(raw, { recursive: true, force: true });

if (!hasRuntime()) {
  // Явно показываем, что оказалось в архиве: молча «не хватает libnode.so» —
  // худший вариант, потому что непонятно, скачивание виновато или структура.
  const shown = (() => {
    try {
      return execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).split('\n')
        .filter((line) => /libnode\.so$|node\.h$/.test(line)).slice(0, 10);
    } catch {
      return ['(список недоступен)'];
    }
  })();
  fail(`после распаковки не хватает заголовков или libnode.so. В архиве нашлось:\n${shown.join('\n') || '(ничего)'}`);
}

const total = MANIFEST.abi
  .map((abi) => statSync(path.join(LIBNODE, 'bin', abi, 'libnode.so')).size)
  .reduce((a, b) => a + b, 0);
info(`готово: Node ${MANIFEST.node}, ${MANIFEST.abi.length} ABI, ${(total / 1048576).toFixed(0)} МБ libnode.so`);
info('дальше: node scripts/android-embed-node.mjs (вживляет рантайм в prebuild-проект)');
