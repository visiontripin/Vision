/**
 * Полнотекстовый поиск (FTS5) по названию, артисту, альбому, жанру и описанию.
 * Таблица поддерживается приложением (а не триггерами), чтобы порядок записи
 * был явным и тестируемым. При первом запуске наполняется из tracks.
 */
export const id = '002-fulltext-search';

export function up(db) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
      id UNINDEXED,
      title,
      artist,
      album,
      genre,
      description,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);

  const indexed = db.prepare('SELECT COUNT(*) AS n FROM tracks_fts').get().n;
  const total = db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
  if (indexed >= total) return;

  const rows = db
    .prepare('SELECT id, title, artist, album, genre, description FROM tracks')
    .all();
  const insert = db.prepare(
    `INSERT INTO tracks_fts (id, title, artist, album, genre, description)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  db.exec('DELETE FROM tracks_fts');
  for (const row of rows) {
    insert.run(row.id, row.title ?? '', row.artist ?? '', row.album ?? '', row.genre ?? '', row.description ?? '');
  }
}
