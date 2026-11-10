/** История прослушиваний: последняя позиция по каждому треку + время. */
export const id = '004-listens';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listens (
      track_id   TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
      position   REAL NOT NULL DEFAULT 0,
      duration   REAL NOT NULL DEFAULT 0,
      completed  INTEGER NOT NULL DEFAULT 0,
      plays      INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_listens_updated ON listens(updated_at DESC);
  `);
}
