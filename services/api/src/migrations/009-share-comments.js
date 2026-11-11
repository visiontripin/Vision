/**
 * Таймкод-комментарии для приглашённых (Фаза 6, E3).
 *
 * Комментарий привязан к секунде трека и к конкретной приватной ссылке: у каждой
 * пары «ссылка + трек» своя лента. Так гость видит только то, что относится к
 * присланному миксу, а не всю переписку владельца.
 *
 * Приватность: `author` — свободное имя, которое гость вводит сам, `author_hash`
 * — sha256(секрет + IP), нужен только для «свои можно удалить» и антиспама.
 * Сырой IP не хранится, как и в `share_hits`.
 */
export const id = '009-share-comments';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS share_comments (
      id          TEXT PRIMARY KEY,
      share_id    TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
      track_id    TEXT NOT NULL,                 -- секунда считается внутри конкретного трека
      at_seconds  REAL NOT NULL,                 -- 0 .. длительность трека
      author      TEXT NOT NULL,                 -- имя, введённое гостем
      author_hash TEXT,                          -- sha256(secret + ip): «свои» и антиспам
      body        TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      deleted_at  TEXT                           -- мягкое удаление: тред не рвётся
    );

    CREATE INDEX IF NOT EXISTS idx_share_comments_share
      ON share_comments(share_id, track_id, at_seconds);
  `);
}
