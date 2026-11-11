/**
 * Резервное копирование с проверкой восстановления (Фаза 5, D5).
 *
 * Задача не «сделать архив», а «знать, что из архива можно восстановиться».
 * Поэтому бэкап здесь — две операции, и вторая обязательна:
 *
 *  1. **снимок**: `VACUUM INTO` копирует живую SQLite-базу консистентно (без
 *     остановки сервера и без `wal_checkpoint`, который может отдать полу-файл),
 *     рядом кладутся `media/` и `covers/`;
 *  2. **проверка**: снимок открывается как база, считается `PRAGMA integrity_check`,
 *     сверяются строки `tracks` и наличие файлов, на которые они ссылаются.
 *     Архив без проверки — это надежда, а не резервная копия.
 *
 * `scripts/backup.sh` остаётся для cron: он умеет то же самое руками и без
 * сервера. Здесь — то, что видно из приложения: когда бэкап был последний раз,
 * сколько он весит, что именно проверено и что делать, если проверка красная.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { DATA_DIR, MEDIA_DIR, COVER_DIR, db } from './connection.js';
import { log } from './lib.js';

/** Сколько архивов держим: 14 дней истории — это уже «вернуться на две недели». */
export const KEEP_ARCHIVES = 14;
export const DEFAULT_BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');

const TABLES_TO_COUNT = ['tracks', 'playlists', 'shares', 'listens', 'listen_events', 'smart_playlists'];

function stamp(now = Date.now()) {
  const iso = new Date(now).toISOString();
  return `${iso.slice(0, 10)}_${iso.slice(11, 16).replace(':', '')}`;
}

/** Размер каталога в байтах (без внешних зависимостей: `du` есть не везде). */
function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

/**
 * Снимок базы. `VACUUM INTO` — единственный способ получить консистентную копию
 * живой базы без остановки сервера: `cp` может поймать середину транзакции.
 */
function snapshotDatabase(target) {
  // VACUUM INTO не перезаписывает существующий файл — это защита от «бэкап поверх».
  rmSync(target, { force: true });
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  return target;
}

/**
 * Проверка архива: открыть снимок и сверить то, что важнее всего.
 *
 * Проверяем не «файл создался», а три вещи, каждая из которых ломает
 * восстановление: целостность SQLite, число треков (сверяется с живой базой) и
 * наличие медиафайлов для треков. Удалённый вручную файл — самая частая поломка,
 * и её видно только так.
 */
/**
 * Корень архива: снимок кладётся в корень, но архивы от `scripts/backup.sh`
 * ранних версий (и чужие сборки) могут содержать один вложенный каталог.
 * Путать это с «архив битый» нельзя — иначе проверка врёт на ровном месте.
 */
export function resolveBackupRoot(dir) {
  if (existsSync(path.join(dir, 'vision.db'))) return dir;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return dir;
  }
  const nested = entries.filter((entry) => entry.isDirectory());
  if (nested.length === 1) {
    const candidate = path.join(dir, nested[0].name);
    if (existsSync(path.join(candidate, 'vision.db'))) return candidate;
  }
  return dir;
}

export function verifyBackup(dir, { expectedTracks = null, checkFiles = true } = {}) {
  dir = resolveBackupRoot(dir);
  const file = path.join(dir, 'vision.db');
  const problems = [];

  if (!existsSync(file)) {
    return { ok: false, problems: ['нет vision.db в архиве'], counts: {}, checkedFiles: 0, missingFiles: [] };
  }

  let snapshot;
  try {
    snapshot = new DatabaseSync(file, { readOnly: true });
    const integrity = snapshot.prepare('PRAGMA integrity_check').get();
    const verdict = integrity?.integrity_check ?? 'unknown';
    if (verdict !== 'ok') problems.push(`integrity_check: ${verdict}`);
  } catch (error) {
    return {
      ok: false,
      problems: [`база не открывается: ${error?.message ?? error}`],
      counts: {},
      checkedFiles: 0,
      missingFiles: [],
    };
  }

  const counts = {};
  for (const table of TABLES_TO_COUNT) {
    try {
      counts[table] = snapshot.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    } catch {
      // таблицы может не быть в базе, созданной до миграции: это не поломка архива
      counts[table] = null;
    }
  }

  if (expectedTracks !== null && counts.tracks !== expectedTracks) {
    problems.push(`треков в архиве ${counts.tracks}, в библиотеке ${expectedTracks}`);
  }

  const missingFiles = [];
  if (checkFiles) {
    let rows = [];
    try {
      rows = snapshot.prepare("SELECT id, checksum, ext FROM tracks").all();
    } catch {
      rows = [];
    }
    const media = path.join(dir, 'media');
    for (const row of rows) {
      // Без расширения судить не о чем: трек мог быть внешним (SoundCloud).
      if (!row.ext) continue;
      /*
       * Имя файла зависит от того, как трек попал в библиотеку: загрузка кладёт
       * `<id>.<ext>`, реплика по контент-адресу — `<checksum>.<ext>`. Проверять
       * только один вариант значит объявлять живой бэкап битым (или наоборот),
       * поэтому принимаем любой из двух — так же, как это делает `localFileFor`.
       */
      const candidates = [`${row.id}.${row.ext}`];
      if (row.checksum) candidates.push(`${row.checksum}.${row.ext}`);
      if (!candidates.some((name) => existsSync(path.join(media, name)))) missingFiles.push(row.id);
    }
    if (missingFiles.length) {
      problems.push(`нет файлов для ${missingFiles.length} треков`);
    }
  }

  snapshot.close();

  return {
    ok: problems.length === 0,
    problems,
    counts,
    checkedFiles: checkFiles ? counts.tracks ?? 0 : 0,
    missingFiles: missingFiles.slice(0, 20),
  };
}

/**
 * Сделать бэкап: снимок базы, медиа, упаковка в `.tar.gz`, проверка.
 *
 * Архив не удаляется, если проверка красная: лучше иметь подозрительный архив и
 * знать, что с ним, чем не иметь никакого. `ok: false` — повод разобраться, а не
 * повод молча перезаписать.
 */
export async function createBackup({ dir = DEFAULT_BACKUP_DIR, now = Date.now(), keep = KEEP_ARCHIVES } = {}) {
  const target = path.resolve(dir);
  mkdirSync(target, { recursive: true });

  const name = `vision-${stamp(now)}`;
  const work = path.join(target, `.${name}-work`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  try {
    const dbSnapshot = snapshotDatabase(path.join(work, 'vision.db'));

    // Медиа копируем целиком: ссылки в базе — на имена файлов, и без них архив
    // восстанавливается в пустую библиотеку с красивыми названиями.
    for (const [source, folder] of [[MEDIA_DIR, 'media'], [COVER_DIR, 'covers']]) {
      if (!existsSync(source)) continue;
      mkdirSync(path.join(work, folder), { recursive: true });
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        copyFileSync(path.join(source, entry.name), path.join(work, folder, entry.name));
      }
    }

    const liveTracks = db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
    const verification = verifyBackup(work, { expectedTracks: liveTracks });

    // Время архива — время снимка, а не упаковки: имя и mtime должны совпадать,
    // иначе «последний бэкап» в панели врёт на минуту.
    const archive = path.join(target, `${name}.tar.gz`);
    const manifest = `${JSON.stringify({
      name,
      createdAt: new Date(now).toISOString(),
      tracks: verification.counts.tracks ?? 0,
      ok: verification.ok,
      problems: verification.problems,
    }, null, 2)}\n`;
    writeFileSync(path.join(work, 'manifest.json'), manifest, 'utf8');

    await packDirectory(work, archive);
    const at = new Date(now);
    utimesSync(archive, at, at);

    const result = {
      ok: verification.ok,
      name,
      archive,
      bytes: statSync(archive).size,
      createdAt: new Date(now).toISOString(),
      verification,
      pruned: [],
    };

    result.pruned = pruneBackups({ dir: target, keep });
    log(verification.ok ? 'info' : 'warn', 'backup created', {
      archive, bytes: result.bytes, tracks: verification.counts.tracks, ok: verification.ok,
      problems: verification.problems,
    });
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Упаковка каталога в `.tar.gz`.
 *
 * `tar` есть в Linux, macOS и Windows 10+, поэтому берём его, а не пишем
 * архиватор на Node: он проверен на путях, длинных именах и правах. Если `tar`
 * нет — честная ошибка вместо полу-архива, который не распакуется.
 */
async function packDirectory(dir, archive) {
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-czf', archive, '-C', dir, '.'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
    });
  });
}

/** Оставить `keep` последних архивов; остальные удалить. */
export function pruneBackups({ dir = DEFAULT_BACKUP_DIR, keep = KEEP_ARCHIVES } = {}) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((file) => /^vision-.*\.tar\.gz$/.test(file))
    .map((file) => {
      const full = path.join(dir, file);
      return { file, full, at: statSync(full).mtimeMs };
    })
    .sort((a, b) => b.at - a.at);

  const removed = [];
  for (const item of files.slice(Math.max(1, keep))) {
    rmSync(item.full, { force: true });
    removed.push(item.file);
  }
  return removed;
}

/**
 * Список архивов для панели: имя, размер, время и — если рядом есть манифест —
 * была ли проверка зелёной. Манифест лежит **внутри** архива, поэтому статус
 * последнего бэкапа переживает перезапуск без отдельной таблицы.
 */
export function listBackups({ dir = DEFAULT_BACKUP_DIR } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => /^vision-.*\.tar\.gz$/.test(file))
    .map((file) => {
      const full = path.join(dir, file);
      const stat = statSync(full);
      return {
        name: file.replace(/\.tar\.gz$/, ''),
        bytes: stat.size,
        createdAt: new Date(stat.mtimeMs).toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Состояние резервного копирования: что есть и о чём стоит беспокоиться. */
export function backupStatus({ dir = DEFAULT_BACKUP_DIR, staleDays = 7, now = Date.now() } = {}) {
  const backups = listBackups({ dir });
  const last = backups[0] ?? null;
  const ageMs = last ? now - Date.parse(last.createdAt) : null;
  const ageDays = ageMs === null ? null : Math.round((ageMs / 86_400_000) * 10) / 10;

  let level = 'ok';
  let hint = null;
  if (!last) {
    level = 'warn';
    hint = 'Резервных копий ещё нет: сделайте первую — до этого архив живёт в одном месте.';
  } else if (ageDays > staleDays) {
    level = 'warn';
    hint = `Последняя копия сделана ${ageDays} дн. назад — стоит настроить её по расписанию (cron).`;
  }

  return {
    dir,
    count: backups.length,
    totalBytes: backups.reduce((sum, item) => sum + item.bytes, 0),
    last,
    ageDays,
    keep: KEEP_ARCHIVES,
    level,
    hint,
    backups,
  };
}

/** Файл медиа по треку — нужен панели, чтобы показать, что именно пропало. */
export function missingMediaFiles({ dir = DATA_DIR } = {}) {
  const rows = db.prepare('SELECT id, title, checksum, ext FROM tracks').all();
  const media = path.join(dir, 'media');
  return rows
    .filter((row) => row.ext)
    .filter((row) => {
      const names = [`${row.id}.${row.ext}`];
      if (row.checksum) names.push(`${row.checksum}.${row.ext}`);
      return !names.some((name) => existsSync(path.join(media, name)));
    })
    .map((row) => ({ id: row.id, title: row.title }));
}

/**
 * Проверка **восстановления** из готового архива: распаковать во временный
 * каталог и прогнать те же проверки, что при создании.
 *
 * Это принципиально отличается от проверки рабочего каталога: архив мог
 * побиться при копировании на другой диск или при скачивании, и узнать об этом
 * лучше сейчас, чем в день, когда он понадобится. Живую библиотеку не трогаем.
 */
export async function verifyArchive(archivePath, { expectedTracks = null } = {}) {
  if (!existsSync(archivePath)) {
    return { ok: false, problems: ['архива нет'], counts: {}, checkedFiles: 0, missingFiles: [] };
  }
  const temp = path.join(path.dirname(archivePath), `.verify-${path.basename(archivePath, '.tar.gz')}`);
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  try {
    await unpackArchive(archivePath, temp);
    const result = verifyBackup(temp, { expectedTracks });
    return { ...result, archive: archivePath, checkedAt: new Date().toISOString() };
  } catch (error) {
    return {
      ok: false,
      problems: [`архив не распаковывается: ${error?.message ?? error}`],
      counts: {},
      checkedFiles: 0,
      missingFiles: [],
      archive: archivePath,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function unpackArchive(archive, dir) {
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
    });
  });
}

/* ------------------------------ расписание ------------------------------- */

/**
 * Интервал автобэкапа в часах. `0` — выключено: дома бэкап на тот же диск
 * бесполезен, если его некуда копировать, и навязывать его нельзя.
 */
export function scheduleHours() {
  const raw = Number(process.env.BACKUP_EVERY_HOURS ?? 24);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(raw, 24 * 7);
}

let schedule = null;
let lastRun = null;

/**
 * Автобэкап по таймеру процесса. Зачем не только cron: cron есть не на всех
 * платформах (Windows, Android/Termux), а «бэкап молча перестал делаться» —
 * самый неприятный из отказов. Панель видит `lastRun` и предупреждает, если
 * копий нет дольше недели (`backupStatus`).
 */
export function startBackupSchedule({ hours = scheduleHours(), dir = DEFAULT_BACKUP_DIR } = {}) {
  if (!hours) return { running: false, hours: 0 };
  const intervalMs = Math.max(hours, 0.05) * 3_600_000;
  const run = async () => {
    try {
      const result = await createBackup({ dir });
      lastRun = { at: new Date().toISOString(), ok: result.ok, name: result.name, problems: result.verification.problems };
    } catch (error) {
      lastRun = { at: new Date().toISOString(), ok: false, error: error?.message ?? String(error) };
      log('warn', 'scheduled backup failed', { error: error?.message });
    }
  };
  // Первый бэкап — не сразу при старте, а через минуту: сервер поднимается,
  // миграции применяются, и только потом имеет смысл снимать копию.
  const first = setTimeout(run, 60_000);
  first.unref?.();
  const interval = setInterval(run, intervalMs);
  interval.unref?.();
  schedule = { cancel: () => { clearTimeout(first); clearInterval(interval); } };
  return { running: true, hours, intervalMs };
}

export function stopBackupSchedule() {
  schedule?.cancel?.();
  schedule = null;
}

export function backupScheduleState() {
  return { hours: scheduleHours(), running: Boolean(schedule), lastRun };
}
