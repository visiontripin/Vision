/**
 * Ссылки на внешние треки (SoundCloud и другие источники).
 *
 * Мы НЕ копируем чужие аудиофайлы: храним только метаданные и адрес официального
 * встроенного плеера. Воспроизведение идёт с серверов источника, наш диск и
 * трафик не расходуются.
 */
export const id = '005-external';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_tracks (
      id          TEXT PRIMARY KEY,
      source      TEXT NOT NULL,
      permalink   TEXT NOT NULL UNIQUE,
      title       TEXT NOT NULL,
      artist      TEXT,
      artwork     TEXT,
      embed_url   TEXT NOT NULL,
      duration    REAL NOT NULL DEFAULT 0,
      note        TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_external_created ON external_tracks(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_external_source ON external_tracks(source);
  `);
}
