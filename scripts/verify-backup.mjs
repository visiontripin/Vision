#!/usr/bin/env node
/**
 * Проверка восстановления из резервной копии (D5) — из терминала.
 *
 * `scripts/backup.sh` уже проверяет снимок, пока он ещё каталогом. Этот скрипт
 * нужен для другого случая: архив скачали с внешнего диска, распаковали и хотят
 * знать **до** восстановления, что он целый. Проверяет то же, что сервер:
 * открывается ли база, цела ли она, есть ли файлы для треков.
 *
 * Использование:
 *   node scripts/verify-backup.mjs /путь/к/распакованному/архиву
 *   node scripts/verify-backup.mjs archive.tar.gz      # распакует во временный каталог
 *
 * Код выхода 0 — восстановление возможно, 1 — нет. Молчаливого «наверное, ок» нет:
 * этот скрипт запускают, когда уже что-то потеряли.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const target = process.argv[2];
if (!target) {
  console.error('Укажите каталог архива или .tar.gz: node scripts/verify-backup.mjs <путь>');
  process.exit(1);
}

let dir = path.resolve(target);
let temp = null;

if (!existsSync(dir)) {
  console.error(`✗ нет такого пути: ${dir}`);
  process.exit(1);
}

// Архив — распаковываем во временный каталог и убираем за собой.
if (statSync(dir).isFile() && dir.endsWith('.tar.gz')) {
  temp = mkdtempSync(path.join(tmpdir(), 'vision-verify-'));
  const unpack = spawnSync('tar', ['-xzf', dir, '-C', temp], { encoding: 'utf8' });
  if (unpack.status !== 0) {
    console.error(`✗ архив не распаковывается: ${(unpack.stderr || '').trim()}`);
    rmSync(temp, { recursive: true, force: true });
    process.exit(1);
  }
  dir = temp;
}

// Архив может содержать один вложенный каталог (так пакуют некоторые сборки) —
// тогда спускаемся в него, а не объявляем архив битым.
if (!existsSync(path.join(dir, 'vision.db'))) {
  const entries = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (entries.length === 1 && existsSync(path.join(dir, entries[0].name, 'vision.db'))) {
    dir = path.join(dir, entries[0].name);
  }
}

const problems = [];
const file = path.join(dir, 'vision.db');

if (!existsSync(file)) {
  console.error(`✗ в ${dir} нет vision.db — это не резервная копия Vision Audio`);
  if (temp) rmSync(temp, { recursive: true, force: true });
  process.exit(1);
}

let counts = {};
let checkedFiles = 0;
try {
  const db = new DatabaseSync(file, { readOnly: true });
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') problems.push(`integrity_check: ${integrity}`);

  for (const table of ['tracks', 'playlists', 'shares', 'listens', 'listen_events']) {
    try {
      counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    } catch {
      counts[table] = null; // таблицы нет в базе до этой миграции — не поломка
    }
  }

  const rows = db.prepare('SELECT id, title, checksum, ext FROM tracks WHERE ext IS NOT NULL').all();
  const media = path.join(dir, 'media');
  const missing = rows.filter((row) => {
    const names = [`${row.id}.${row.ext}`];
    if (row.checksum) names.push(`${row.checksum}.${row.ext}`);
    return !names.some((name) => existsSync(path.join(media, name)));
  });
  checkedFiles = rows.length - missing.length;
  if (missing.length) {
    problems.push(`нет файлов для ${missing.length} треков`);
    for (const row of missing.slice(0, 5)) console.error(`   · ${row.id} — ${row.title}`);
  }
  db.close();
} catch (error) {
  problems.push(`база не открывается: ${error?.message ?? error}`);
}

const manifest = (() => {
  const file = path.join(dir, 'manifest.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
})();

if (temp) rmSync(temp, { recursive: true, force: true });

if (manifest) {
  console.log(`манифест: от ${manifest.createdAt}, треков ${manifest.tracks}, проверка ${manifest.ok ? 'ok' : 'красная'}`);
}

if (problems.length) {
  console.error(`✗ восстановление невозможно: ${problems.join('; ')}`);
  process.exit(1);
}

console.log(
  `✓ архив целый: треков ${counts.tracks ?? 0}, плейлистов ${counts.playlists ?? 0}, ` +
  `файлов на месте ${checkedFiles}`
);
console.log('  восстановление: остановите сервер, распакуйте архив в DATA_DIR (vision.db, media/, covers/) и запустите заново.');
