/**
 * Журнал действий (Фаза 6, G10): «кто удалил трек», «кто открывал ссылку».
 *
 * Пишем в БД, а не только в stdout: вопрос «что было в прошлый вторник» задают
 * позже, а логи на сервере ротируются и уезжают. Персональных данных нет:
 * адрес — это `sha256(VISION_SECRET + ip)`, тот же хеш, что в `share_hits`,
 * поэтому события одного гостя сопоставимы между собой, но не с человеком.
 */
export const id = '010-audit-log';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          TEXT NOT NULL,
      actor       TEXT NOT NULL,                 -- owner | guest | system
      action      TEXT NOT NULL,                 -- track.delete, share.open, …
      target_kind TEXT,                          -- track | playlist | share | comment | system
      target_id   TEXT,
      share_id    TEXT,                          -- без ON DELETE CASCADE: журнал переживает объект
      ip_hash     TEXT,                          -- sha256(secret + ip), без сырого адреса
      request_id  TEXT,                          -- совпадает с X-Request-Id ответа
      details     TEXT                           -- JSON ≤ 2 КБ (заголовок, счётчик повторов)
    );

    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_share ON audit_log(share_id, at DESC);
    -- дешёвый поиск «недавно то же самое» для схлопывания гостевых визитов
    CREATE INDEX IF NOT EXISTS idx_audit_dedupe ON audit_log(action, actor, ip_hash, at DESC);
  `);
}
