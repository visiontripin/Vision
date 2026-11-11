/**
 * Дашборд владельца (Фаза 5, D1) — `docs/API.md`, раздел «Дашборд владельца».
 *
 * Вопрос, на который отвечает дашборд: «что слушают и когда» — по своим
 * прослушиваниям и по гостевым ссылкам. Это статистика **прослушиваний**, а не
 * аналитика по людям: сырых адресов нет, география — по хешу адреса, который
 * считается тем же способом, что в `share_hits` и `audit_log`.
 *
 * Решения, которые видны в контракте:
 *  - **дни локальные, а не UTC**: «вчера» для человека в Амстердаме — не то же
 *    самое, что «вчера» по UTC. Храним ISO-время, группируем по смещению
 *    сервера (или явному `tz` в минутах);
 *  - **`plays` ≠ «включил»**: событие `play` пишется не чаще раза в 30 минут на
 *    трек, поэтому повтор одного трека не накручивает график;
 *  - **`complete` — отдельная метрика**: «дослушали» полезнее, чем «включили»;
 *  - **треки, которых уже нет**, остаются в статистике по названию: удалять
 *    историю вместе с треком — значит терять ответ на вопрос «что слушали»;
 *  - **пустые дни заполняются нулями**: график не должен «склеивать» понедельник
 *    и пятницу, если в середине ничего не играло.
 *
 * События приходят из `recordListen` (своё прослушивание) и из выдачи по
 * гостевым ссылкам че��ез `logPlayback`.
 */
import { db } from './db.js';
import { auditIpHash } from './audit.js';

export const DASHBOARD_DAYS = 30;
export const PLAY_DEDUPE_MS = 30 * 60_000;
export const TOP_LIMIT = 10;

const DAY_MS = 86_400_000;

/** Смещение сервера в минутах — «день» дашборда совпадает с днём человека. */
function offsetMinutes(now) {
  return -new Date(now).getTimezoneOffset();
}

/** Ключ дня `YYYY-MM-DD` для момента `iso` с учётом смещения. */
function dayKey(iso, offset = 0) {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(time + offset * 60_000).toISOString().slice(0, 10);
}

/**
 * Запись события прослушивания.
 *
 * `kind: 'play'` схлопывается: если по этому треку уже было `play` за последние
 * 30 минут, второе событие не пишется. Это единственное место, где «прослушивание»
 * становится числом, поэтому дедупликация здесь, а не в SQL-выборке: иначе она
 * зависела бы от каждого запроса дашборда.
 */
export function logPlayback({
  trackId,
  kind = 'play',
  position = 0,
  duration = 0,
  source = 'owner',
  shareId = null,
  ip = null,
  at = new Date().toISOString(),
} = {}) {
  if (!trackId) return { recorded: false, reason: 'no_track' };
  const time = new Date(at).getTime();
  if (!Number.isFinite(time)) return { recorded: false, reason: 'bad_time' };

  if (kind === 'play') {
    const since = new Date(time - PLAY_DEDUPE_MS).toISOString();
    const last = db
      .prepare(
        `SELECT at FROM listen_events
          WHERE track_id = ? AND kind = 'play' AND at >= ?
          ORDER BY at DESC LIMIT 1`
      )
      .get(trackId, since);
    if (last) return { recorded: false, reason: 'duplicate', at: last.at };
  }

  db.prepare(
    `INSERT INTO listen_events (track_id, kind, position, duration, source, share_id, ip_hash, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    trackId,
    ['play', 'complete', 'skip'].includes(kind) ? kind : 'play',
    Math.max(0, Number(position) || 0),
    Math.max(0, Number(duration) || 0),
    source === 'share' ? 'share' : 'owner',
    shareId,
    ip ? auditIpHash(ip) : null,
    new Date(time).toISOString()
  );

  return { recorded: true };
}

/**
 * Агрегаты за окно `days` (1…365).
 *
 * `tz` — смещение в минутах; по умолчанию берётся у сервера, чтобы «сегодня» в
 * дашборде и в приветствии «Для вас» означало одно и то же.
 */
export function dashboard({ days = DASHBOARD_DAYS, now = Date.now(), tz = null, top = TOP_LIMIT } = {}) {
  const span = Math.min(Math.max(Number(days) || DASHBOARD_DAYS, 1), 365);
  const offset = Number.isFinite(Number(tz)) && tz !== null ? Number(tz) : offsetMinutes(now);
  const until = new Date(now).toISOString();
  const since = new Date(now - span * DAY_MS).toISOString();

  /*
   * Названия берём из `tracks` и храним в событиях только id: переименование
   * трека должно менять дашборд, а не оставлять в топе старое имя. Если трек
   * удалён, LEFT JOIN даёт NULL — и в топе будет «трек удалён» с id: это честнее,
   * чем выкинуть прослушивания из статистики.
   */
  const totals = db
    .prepare(
      `SELECT
         SUM(CASE WHEN kind = 'play' THEN 1 ELSE 0 END) AS plays,
         SUM(CASE WHEN kind = 'complete' THEN 1 ELSE 0 END) AS completed,
         COUNT(DISTINCT track_id) AS tracks,
         COUNT(DISTINCT ip_hash) AS listeners,
         SUM(CASE WHEN source = 'share' THEN 1 ELSE 0 END) AS shared
       FROM listen_events WHERE at >= ? AND at <= ?`
    )
    .get(since, until);

  const perDay = db
    .prepare(
      `SELECT at, kind, source FROM listen_events WHERE at >= ? AND at <= ? ORDER BY at`
    )
    .all(since, until);

  const byDay = new Map();
  // Заполняем все дни окна нулями: иначе график «съедает» паузы в неделю.
  const todayKey = dayKey(until, offset);
  const startKey = dayKey(since, offset);
  for (let i = 0; i <= span; i += 1) {
    const key = dayKey(new Date(new Date(`${startKey}T00:00:00Z`).getTime() + i * DAY_MS).toISOString(), 0);
    if (!key || key > todayKey) break;
    byDay.set(key, { day: key, plays: 0, completed: 0, shared: 0 });
  }
  for (const row of perDay) {
    const bucket = byDay.get(dayKey(row.at, offset));
    if (!bucket) continue; // крайние дни: событие вне окна после сдвига
    if (row.kind === 'play') bucket.plays += 1;
    if (row.kind === 'complete') bucket.completed += 1;
    if (row.source === 'share') bucket.shared += 1;
  }

  const topTracks = db
    .prepare(
      `SELECT e.track_id AS id, t.title AS title, t.artist AS artist,
              SUM(CASE WHEN e.kind = 'play' THEN 1 ELSE 0 END) AS plays,
              SUM(CASE WHEN e.kind = 'complete' THEN 1 ELSE 0 END) AS completed
         FROM listen_events e
         LEFT JOIN tracks t ON t.id = e.track_id
        WHERE e.at >= ? AND e.at <= ?
        GROUP BY e.track_id
        -- только прослушанное: строка «дослушал, но ни разу не включал» невозможна.
        -- Алиас в HAVING не годится: SQLite там его не знает, нужен полный агрегат.
        HAVING SUM(CASE WHEN e.kind = 'play' THEN 1 ELSE 0 END) > 0
        ORDER BY plays DESC, completed DESC, e.track_id
        LIMIT ?`
    )
    .all(since, until, Math.min(Math.max(Number(top) || TOP_LIMIT, 1), 50))
    .map((row) => ({
      id: row.id,
      title: row.title,
      artist: row.artist,
      deleted: row.title === null,
      plays: row.plays,
      completed: row.completed,
    }));

  /*
   * «Источники» — свои прослушивания против гостевых по ссылкам. Отдельно от
   * географии: по одной ссылке могут слушать из десяти мест, и это не значит,
   * что у владельца десять слушателей.
   */
  const bySource = db
    .prepare(
      `SELECT source, COUNT(*) AS n FROM listen_events
        WHERE at >= ? AND at <= ? AND kind = 'play' GROUP BY source`
    )
    .all(since, until);
  const sources = { owner: 0, share: 0 };
  for (const row of bySource) sources[row.source] = row.n;

  /*
   * География по хешу адреса. Без GeoIP-базы точный город не узнать, поэтому
   * дашборд не притворяется: отдаём «сколько разных адресов» и их топ по числу
   * прослушиваний. Это отвечает на вопрос «слушают из одного места или из
   * десяти», не требуя внешних сервисов и не сохраняя адреса.
   */
  const listeners = db
    .prepare(
      `SELECT ip_hash AS hash, COUNT(*) AS plays, COUNT(DISTINCT track_id) AS tracks,
              MIN(at) AS first, MAX(at) AS last
         FROM listen_events
        WHERE at >= ? AND at <= ? AND ip_hash IS NOT NULL AND kind = 'play'
        GROUP BY ip_hash
        ORDER BY plays DESC, hash
        LIMIT 10`
    )
    .all(since, until)
    .map((row) => ({
      // короткий отпечаток: полный хеш ничего не добавляет человеку, а в ссылках выглядит угрожающе
      id: String(row.hash).slice(0, 8),
      plays: row.plays,
      tracks: row.tracks,
      firstSeen: row.first,
      lastSeen: row.last,
    }));

  return {
    since,
    until,
    days: span,
    tz: offset,
    totals: {
      plays: totals.plays ?? 0,
      completed: totals.completed ?? 0,
      tracks: totals.tracks ?? 0,
      listeners: totals.listeners ?? 0,
      sharedPlays: totals.shared ?? 0,
    },
    sources,
    byDay: [...byDay.values()],
    topTracks,
    listeners,
    /**
     * Пустой дашборд — не ошибка: пока ничего не слушали, график нулевой.
     * `hint` объясняет, что для событий нужен хотя бы один запущенный трек.
     */
    hint: (totals.plays ?? 0) > 0
      ? null
      : 'Прослушиваний пока нет: включите трек — события появятся в дашборде.',
  };
}
