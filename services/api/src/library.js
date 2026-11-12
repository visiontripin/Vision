import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { DATA_DIR, db } from './connection.js';
import { log } from './lib.js';
import { mimeForExt } from './seeds.js';

/** Mime → расширение файла. Своя копия таблицы не нужна: расширение знает `seeds`. */
function extForMime(mime) {
  const match = /^audio\/(mpeg|mp4|aac|ogg|opus|flac|wav|x-wav|webm|aiff)$/i.exec(String(mime ?? '').split(';')[0].trim());
  if (!match) return 'mp3';
  const key = match[1].toLowerCase();
  return key === 'mpeg' ? 'mp3' : key === 'x-wav' ? 'wav' : key === 'mp4' ? 'm4a' : key;
}

/**
 * Реестр общей библиотеки: «что у кого есть» + файлы.
 *
 * Модуль отвечает только за данные. Транспорт (`POST /api/library`, `PUT/GET
 * /api/library/:id/file`) — в `server.js`, чтобы правила авторизации и чтения
 * тела оставались в одном месте.
 *
 * Три решения, которые важно не потерять при правках:
 *
 * 1. **Метаданные и файл — разные вещи.** Устройство может отметиться и без
 *    файла (`downloadable: false`): так видно «трек есть у Ани, но скачать пока
 *    нечего». Молча терять такой трек нельзя — иначе лента врёт.
 * 2. **Время обновления не перетирается.** `updated_at` берётся с устройства, а
 *    не с сервера: иначе каждая синхронизация выглядела бы как новое изменение.
 * 3. **Файл кладётся один раз.** Повторная загрузка того же трека не мешает:
 *    путь один и тот же (`library/<id>.<ext>`), запись обновляется.
 */

/** Каталог файлов общей библиотеки: отдельно от медиатеки, чтобы бэкап их не путал. */
const LIBRARY_DIR = path.join(DATA_DIR, 'library');

/** Сколько устройство считается живым без отметки. Совпадает с клиентом (15 минут). */
export const DEVICE_TTL_MS = 15 * 60 * 1000;

/** Предел одной загрузки: как у серверной загрузки треков (500 МБ). */
export const MAX_LIBRARY_BYTES = 500 * 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

export function touchDevice({ id, name, baseUrl = null, at = nowIso() }) {
  if (!id) return null;
  const cleanName = String(name ?? '').trim().slice(0, 60) || 'Устройство';
  db.prepare(
    `INSERT INTO library_devices (id, name, base_url, seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, seen_at = excluded.seen_at`
  ).run(String(id).slice(0, 80), cleanName, baseUrl ? String(baseUrl).slice(0, 300) : null, at);
  return { id, name: cleanName, baseUrl, at };
}

/**
 * Приём пачки треков от устройства.
 *
 * Возвращает количество принятых и отклонённых: клиенту важно знать, что часть
 * данных не подошла (битые записи не должны валить всю синхронизацию).
 */
export function upsertTracks(device, tracks) {
  if (!Array.isArray(tracks)) return { accepted: 0, rejected: 0 };
  const statement = db.prepare(
    `INSERT INTO library_tracks
       (id, title, artist, album, genre, duration, mime, bytes, checksum, device_id, device_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, artist = excluded.artist, album = excluded.album, genre = excluded.genre,
       duration = excluded.duration, mime = excluded.mime, bytes = excluded.bytes, checksum = excluded.checksum,
       device_id = excluded.device_id, device_name = excluded.device_name, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= library_tracks.updated_at`
  );

  let accepted = 0;
  let rejected = 0;
  for (const track of tracks.slice(0, 5000)) {
    const id = String(track?.id ?? '').trim();
    const title = String(track?.title ?? '').trim();
    if (!id || !title) {
      rejected += 1;
      continue;
    }
    statement.run(
      id.slice(0, 120),
      title.slice(0, 300),
      String(track.artist ?? '').slice(0, 120),
      track.album ? String(track.album).slice(0, 160) : null,
      track.genre ? String(track.genre).slice(0, 80) : null,
      Math.max(0, Math.round(Number(track.duration) || 0)),
      String(track.mime ?? 'audio/mpeg').slice(0, 80),
      Math.max(0, Math.round(Number(track.bytes) || 0)),
      track.checksum ? String(track.checksum).slice(0, 64) : null,
      device.id,
      device.name,
      String(track.updatedAt ? new Date(Number(track.updatedAt)).toISOString() : nowIso()).slice(0, 40)
    );
    accepted += 1;
  }
  return { accepted, rejected };
}

/** Устройства, которые отметились за окно жизни; сначала свежие. */
export function listDevices(now = Date.now()) {
  const from = new Date(now - DEVICE_TTL_MS).toISOString();
  return db
    .prepare('SELECT id, name, base_url, seen_at FROM library_devices WHERE seen_at >= ? ORDER BY seen_at DESC')
    .all(from)
    .map((row) => ({ id: row.id, name: row.name, baseUrl: row.base_url, at: Date.parse(row.seen_at) || 0 }));
}

/** Всё, что известно реестру: метаданные живых устройств + отметка о файлах. */
export function snapshot(now = Date.now()) {
  const from = new Date(now - DEVICE_TTL_MS).toISOString();
  const devices = listDevices(now);
  const tracks = db
    .prepare(
      `SELECT t.*, f.track_id AS file_id FROM library_tracks t
       LEFT JOIN library_files f ON f.track_id = t.id
       WHERE t.device_id IN (SELECT id FROM library_devices WHERE seen_at >= ?)
       ORDER BY t.updated_at DESC`
    )
    .all(from)
    .map((row) => ({
      id: row.id,
      title: row.title,
      artist: row.artist,
      album: row.album,
      genre: row.genre,
      duration: row.duration,
      mime: row.mime,
      bytes: row.bytes,
      checksum: row.checksum,
      deviceId: row.device_id,
      deviceName: row.device_name,
      downloadable: Boolean(row.file_id),
      updatedAt: Date.parse(row.updated_at) || 0,
    }));

  const published = {};
  for (const row of db.prepare('SELECT track_id FROM library_files').all()) published[row.track_id] = true;
  return { version: 1, devices, tracks, published };
}

export function getLibraryTrack(id) {
  return db.prepare('SELECT * FROM library_tracks WHERE id = ?').get(id) ?? null;
}

export function getLibraryFile(id) {
  const row = db.prepare('SELECT * FROM library_files WHERE track_id = ?').get(id) ?? null;
  if (!row) return null;
  const file = path.join(DATA_DIR, row.path);
  if (!existsSync(file)) {
    // Запись есть, файла нет (почистили диск) — честно убираем, иначе скачивание
    // будет вечно отвечать 500 вместо понятного «нет файла».
    db.prepare('DELETE FROM library_files WHERE track_id = ?').run(id);
    return null;
  }
  return { ...row, file };
}

/**
 * Сохранение файла из тела запроса.
 *
 * Читаем потоком и считаем sha256 на лету: файл может быть в сотни мегабайт, а
 * `readFile` в память на телефоне-сервере — верный способ получить OOM.
 */
export async function saveLibraryFile(id, stream, { mime, limit = MAX_LIBRARY_BYTES } = {}) {
  mkdirSync(LIBRARY_DIR, { recursive: true });

  const ext = extForMime(mime);
  const relative = path.join('library', `${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.${ext}`);
  const target = path.join(DATA_DIR, relative);
  const temp = `${target}.part`;

  const hash = createHash('sha256');
  let bytes = 0;

  /*
   * Источник может быть двух видов: `req` (поток тела) и объект из
   * `firstPartStream` для multipart — у него байты приходят через
   * `stream[Symbol.asyncIterator]()`. Поэтому читаем явным `for await`, а не
   * `pipe`: одна ветка кода на оба вида тела.
   */
  const out = createWriteStream(temp);
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limit) {
        throw Object.assign(new Error('too_large'), { code: 'too_large' });
      }
      hash.update(buffer);
      if (!out.write(buffer)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
  } catch (error) {
    out.destroy();
    rmSync(temp, { force: true });
    // Свои коды (`too_large`) отдаём как есть; любой сбой чтения — «файл не
    // сохранился», а не «пустой файл»: иначе клиент получает неверную подсказку.
    const wrapped = Object.assign(new Error('upload_failed'), { code: 'upload_failed' });
    wrapped.cause = error;
    // Диагностика в лог: иначе причина видна только как «не сохранился».
    log('warn', 'library: save failed', { code: error?.code ?? null, error: error?.message });
    throw error.code === 'too_large' ? error : wrapped;
  }

  if (!bytes) {
    rmSync(temp, { force: true });
    throw Object.assign(new Error('empty_file'), { code: 'empty_file' });
  }

  renameSync(temp, target);

  db.prepare(
    `INSERT INTO library_files (track_id, path, bytes, mime, uploaded_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(track_id) DO UPDATE SET path = excluded.path, bytes = excluded.bytes,
       mime = excluded.mime, uploaded_at = excluded.uploaded_at`
  ).run(id, relative, bytes, mime ?? mimeForExt(ext), nowIso());

  return { bytes, checksum: hash.digest('hex'), file: target, path: relative };
}

/** Раздача файла с поддержкой Range: без неё не работает перемотка. */
export function streamLibraryFile(req, res, record) {
  const size = statSync(record.file).size;
  const rangeHeader = req.headers.range;
  const common = {
    'Content-Type': record.mime || 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  };

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end) {
        res.writeHead(206, {
          ...common,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': end - start + 1,
        });
        createReadStream(record.file, { start, end }).pipe(res);
        return;
      }
    }
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }

  res.writeHead(200, { ...common, 'Content-Length': size });
  createReadStream(record.file).pipe(res);
}

/** Удаление трека из реестра (например, владелец убрал его из библиотеки). */
export function removeLibraryTrack(id) {
  const file = db.prepare('SELECT path FROM library_files WHERE track_id = ?').get(id);
  if (file?.path) rmSync(path.join(DATA_DIR, file.path), { force: true });
  db.prepare('DELETE FROM library_files WHERE track_id = ?').run(id);
  db.prepare('DELETE FROM library_tracks WHERE id = ?').run(id);
}

/** Размер общей библиотеки на диске — для панели и статистики. */
export function libraryStats() {
  const row = db.prepare('SELECT COUNT(*) AS tracks, COALESCE(SUM(bytes),0) AS bytes FROM library_files').get();
  return { tracks: row.tracks, bytes: row.bytes };
}

export { LIBRARY_DIR };
