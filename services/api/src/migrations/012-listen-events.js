/**
 * События прослушиваний для дашборда владельца (Фаза 5, D1).
 *
 * Зачем отдельная таблица, если есть `listens` (004)? `listens` — **состояние**:
 * одна строка на трек, свежая позиция и счётчик `plays`. Для «продолжить
 * слушать» этого достаточно, а для «сколько слушали во вторник» — нет: состояние
 * перезаписывается, история теряется.
 *
 * Поэтому события пишутся лентой: `play` — когда трек действительно заиграл,
 * `complete` — когда дошли до конца. Пишем не каждый тик плеера, а один `play`
 * на трек за 30 минут (`dedupe` в `dashboard.js`): иначе один и тот же трек,
 * поставленный на повтор, накрутил бы тысячи «прослушиваний».
 *
 * `ip_hash` — тот же `sha256(secret + ip)`, что в `share_hits` и `audit_log`:
 * сырой адрес не хранится никогда, но «слушают из 3 городов» посчитать можно.
 * `source` отделяет свои прослушивания от гостевых по ссылке: дашборд честно
 * показывает «5 моих, 12 по ссылкам», а не одну общую цифру.
 */
export const id = '012-listen-events';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listen_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id  TEXT NOT NULL,                  -- без FK: событие переживает удаление трека
      kind      TEXT NOT NULL DEFAULT 'play',   -- play | complete | skip
      position  REAL NOT NULL DEFAULT 0,        -- где были в момент события
      duration  REAL NOT NULL DEFAULT 0,
      source    TEXT NOT NULL DEFAULT 'owner',  -- owner | share
      share_id  TEXT,                           -- если source = share
      ip_hash   TEXT,                           -- sha256(secret + ip), не адрес
      at        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_listen_events_at ON listen_events(at);
    CREATE INDEX IF NOT EXISTS idx_listen_events_track ON listen_events(track_id, at);
  `);
}
