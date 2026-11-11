/**
 * Умные плейлисты по правилам (Фаза 5, C7).
 *
 * `smart_playlists` хранит **правила**, а не треки: состав пересчитывается при
 * каждом открытии. Отдельная таблица, а не флаг у `playlists`, потому что у
 * умного плейлиста нет `playlist_tracks` — добавлять треки руками бессмысленно,
 * их выбирает правило.
 *
 * `rules` — JSON: `{match: 'all'|'any', rules: [{field, op, value}], sort, limit}`.
 * Разбор и валидация — `services/api/src/smart.js`; значения попадают в SQL
 * только параметрами, поэтому правилом нельзя подставить запрос.
 */
export const id = '011-smart-playlists';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS smart_playlists (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      rules       TEXT NOT NULL,               -- JSON, см. комментарий выше
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_smart_created ON smart_playlists(created_at DESC);
  `);
}
