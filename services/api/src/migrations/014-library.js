/**
 * Общая библиотека между устройствами (сеть, а не только Wi-Fi).
 *
 * Владелец хочет: загрузил пять песен на одном телефоне — второе устройство с
 * тем же приложением сразу видит их в ленте. Требование «при любом подключении
 * к сети» исключает прямой обмен между телефонами: за NAT и в мобильной сети
 * входящие соединения не работают, а телефон ещё и засыпает.
 *
 * Поэтому вводится **реестр** — маленькая совместная таблица:
 *
 * - каждое устройство раз в 20 секунд шлёт свои метаданные (`POST /api/library`)
 *   и получает в ответ всё, что знают остальные;
 * - файл уходит в реестр один раз (`PUT /api/library/:id/file`) и скачивается
 *   оттуда любым устройством (`GET /api/library/:id/file`) — в любой сети;
 * - «на связи» — устройство, отметившееся за последние 15 минут.
 *
 * Политика доступа: реестр — это ваша библиотека, а не публичный каталог. Чтение
 * и запись требуют токен владельца (как и остальные `/api/*`), поэтому чужой
 * человек в том же Wi-Fi ничего не увидит.
 */
export const id = '014-library';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_devices (
      id         TEXT PRIMARY KEY,              -- стабильный id установки
      name       TEXT NOT NULL,                 -- «Телефон A1» — чтобы различать свои
      base_url   TEXT,                          -- адрес раздачи (NULL — не раздаёт)
      seen_at    TEXT NOT NULL                  -- последняя отметка: по ней считается «на связи»
    );

    CREATE TABLE IF NOT EXISTS library_tracks (
      id          TEXT PRIMARY KEY,             -- id трека на устройстве-владельце
      title       TEXT NOT NULL,
      artist      TEXT NOT NULL DEFAULT '',
      album       TEXT,
      genre       TEXT,
      duration    INTEGER NOT NULL DEFAULT 0,
      mime        TEXT NOT NULL DEFAULT 'audio/mpeg',
      bytes       INTEGER NOT NULL DEFAULT 0,
      checksum    TEXT,                         -- sha256: дедупликация между устройствами
      device_id   TEXT NOT NULL,
      device_name TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS library_files (
      track_id    TEXT PRIMARY KEY,
      path        TEXT NOT NULL,                -- относительно каталога данных
      bytes       INTEGER NOT NULL,
      mime        TEXT NOT NULL DEFAULT 'audio/mpeg',
      uploaded_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_library_tracks_device ON library_tracks(device_id);
    CREATE INDEX IF NOT EXISTS idx_library_tracks_updated ON library_tracks(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_library_devices_seen ON library_devices(seen_at DESC);
  `);
}
