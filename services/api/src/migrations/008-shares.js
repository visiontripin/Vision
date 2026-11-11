/**
 * Приватные ссылки на треки и плейлисты (Фаза 6, E1).
 *
 * Ссылка — не сессионный токен: это отдельная случайная строка, которую можно
 * отозвать, ограничить сроком жизни и посчитать по ней прослушивания гостей.
 * В базе лежит только sha256 токена: утечка дампа БД не даёт рабочий URL.
 */
export const id = '008-shares';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shares (
      id           TEXT PRIMARY KEY,
      token_hash   TEXT NOT NULL UNIQUE,        -- sha256(token), сам токен не храним
      prev_token_hash TEXT,                     -- предыдущий токен: по нему отвечаем 410, а не 404
      target_kind  TEXT NOT NULL,               -- track | playlist
      target_id    TEXT NOT NULL,
      title        TEXT,                        -- подпись владельца («для Димы»)
      expires_at   TEXT,                        -- NULL = бессрочная
      max_plays    INTEGER,                     -- NULL = без лимита
      plays        INTEGER NOT NULL DEFAULT 0,
      revoked_at   TEXT,
      last_seen_at TEXT,
      created_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_shares_target ON shares(target_kind, target_id);
    CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token_hash);

    CREATE TABLE IF NOT EXISTS share_hits (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      share_id   TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
      ip_hash    TEXT,                          -- sha256(ip + secret), без сырого IP
      kind       TEXT NOT NULL,                 -- open | stream | download
      at         TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_share_hits_share ON share_hits(share_id, at);
  `);
}
