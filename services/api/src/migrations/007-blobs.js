/**
 * Контент-адресация и реестр реплик: «где лежит файл» вместо «файл на сервере».
 *
 * `blobs`      — содержимое (sha256) и его параметры: размер, mime.
 * `blob_seeds` — кто это содержимое раздаёт прямо сейчас (heartbeat).
 *
 * Треки ссылаются на блоб через `tracks.checksum`, поэтому дубликат файла —
 * это одна и та же строка `blobs` с несколькими сидами.
 */
export const id = '007-blobs';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blobs (
      hash       TEXT PRIMARY KEY,             -- sha256 содержимого (hex)
      bytes      INTEGER NOT NULL DEFAULT 0,
      mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blob_seeds (
      hash       TEXT NOT NULL,
      device_id  TEXT NOT NULL,                -- устройство, а не пользователь
      kind       TEXT NOT NULL,                -- origin | node | desktop | mobile | browser
      base_url   TEXT,                         -- откуда качать; у browser/mobile может быть null
      servable   INTEGER NOT NULL DEFAULT 0,   -- 1 = умеет отдать файл по HTTP
      online_at  INTEGER NOT NULL,             -- heartbeat, ms epoch
      PRIMARY KEY (hash, device_id)
    );

    CREATE INDEX IF NOT EXISTS idx_blob_seeds_hash ON blob_seeds(hash, servable);
    CREATE INDEX IF NOT EXISTS idx_blob_seeds_online ON blob_seeds(online_at);
  `);

  // Уже загруженные треки сразу становятся блобами: адрес контента — их sha256.
  db.exec(`
    INSERT OR IGNORE INTO blobs (hash, bytes, mime, created_at)
      SELECT checksum, size, mime, created_at
        FROM tracks
       WHERE checksum IS NOT NULL AND length(checksum) = 64;
  `);
}
