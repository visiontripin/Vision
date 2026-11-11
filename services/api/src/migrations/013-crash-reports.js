/**
 * Отчёты о падениях клиентов (Фаза 3, H5 — crash-репортинг).
 *
 * Зачем своя таблица, а не Sentry: у проекта нет аккаунтов и внешних сервисов, а
 * «приложение упало и молчит» — самый дорогой из отказов на телефоне, потому что
 * владелец не может повторить сценарий за пользователя. Отчёт приходит сюда,
 * виден в панели и не требует ни одного стороннего запроса.
 *
 * Персональных данных нет: `device_id` — это идентификатор **установки**, а не
 * человека (тот же, что клиенты и раньше отправляли в трекер реплик). Тексты
 * ошибок сохраняются как есть: без них отчёт бесполезен. Поэтому обрезаем по
 * длине и ограничиваем частоту — журнал не должен превращаться в канал утечки
 * или в мусорку на диске.
 *
 * `fingerprint` — грубая подпись одинаковых падений (`name:message:первый кадр`):
 * без неё список из 200 «TypeError: undefined» невозможно читать.
 */
export const id = '013-crash-reports';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crash_reports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL,                -- подпись одинаковых падений
      app         TEXT NOT NULL DEFAULT 'mobile', -- mobile | web | desktop | console
      version     TEXT,                          -- версия приложения
      platform    TEXT,                          -- android | ios | web | windows
      release     TEXT,                          -- версия ОС / сборки
      name        TEXT,                          -- TypeError, Error, …
      message     TEXT,
      stack       TEXT,                          -- обрезанный стек
      context     TEXT,                          -- JSON: что было открыто
      device_id   TEXT,                          -- идентификатор установки, не человека
      count       INTEGER NOT NULL DEFAULT 1,    -- сколько раз повторилось
      first_at    TEXT NOT NULL,
      last_at     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_crash_fingerprint ON crash_reports(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_crash_last ON crash_reports(last_at DESC);
  `);
}
