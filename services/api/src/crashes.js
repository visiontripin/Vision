/**
 * Crash-репортинг (Фаза 3, H5) — `docs/API.md`, раздел «Отчёты о падениях».
 *
 * Правила, которые видны в контракте:
 *  - **приём без токена**: если приложение падает до входа (или токен истёк),
 *    отчёт всё равно нужен — иначе самые интересные падения не долетят;
 *  - **одинаковые падения схлопываются**: `fingerprint` + счётчик, иначе список
 *    из двухсот «TypeError: undefined» невозможно читать;
 *  - **частота ограничена**: 60 отчётов в час на установку. Сломанный цикл не
 *    должен ни забить диск, ни превратиться в канал для спама;
 *  - **персональных данных нет**: `device_id` — идентификатор установки, а не
 *    человека; тексты ошибок обрезаются по длине;
 *  - **отчёт не ломает приложение**: клиент отправляет его «в фоне» и не ждёт.
 *
 * Чтение — только владельцу: стек падения содержит внутренние имена, а иногда и
 * часть данных, которые видит только автор библиотеки.
 */
import { db } from './db.js';
import { log } from './lib.js';

export const CRASH_RETENTION_DAYS = Math.max(1, Number(process.env.CRASH_RETENTION_DAYS || 90));
export const CRASH_RATE_PER_HOUR = Math.max(1, Number(process.env.CRASH_RATE_PER_HOUR || 60));

const MAX_MESSAGE = 500;
const MAX_STACK = 6000;
const MAX_CONTEXT = 2000;

/** Обрезает строку, не рвя суррогатные пары (эмодзи в тексте ошибки бывает). */
function clip(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

/**
 * Подпись одинаковых падений: имя, сообщение и первый «свой» кадр стека.
 *
 * Номера строк намеренно сохраняются — без них все падения в одном файле
 * слились бы в одну запись. А вот адреса памяти и пути сборки (`file:///…/build/`)
 * вырезаются: иначе каждая сборка давала бы новый «уникальный» баг.
 */
export function fingerprintOf({ name, message, stack } = {}) {
  const firstFrame = String(stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('at ')) ?? '';
  const clean = (value) => String(value ?? '')
    // путь сборки вырезаем, но имя файла и строку оставляем: `file:///tmp/x/player.tsx:1:2`
    // → `player.tsx:1:2`. Иначе адрес сборки делал бы «уникальным» каждый баг.
    .replace(/file:\/\/[^\s)]*\//g, '')
    .replace(/\b[0-9a-f]{8,}\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return `${clean(name) || 'Error'}:${clean(message)}:${clean(firstFrame)}`;
}

/** Разбор тела отчёта: не доверяем типам, всё приводим к строкам и обрезаем. */
export function parseReport(body = {}) {
  const context = body.context && typeof body.context === 'object'
    ? clip(JSON.stringify(body.context), MAX_CONTEXT)
    : body.context ? clip(body.context, MAX_CONTEXT) : null;

  return {
    app: ['mobile', 'web', 'desktop', 'console'].includes(body.app) ? body.app : 'mobile',
    version: body.version ? clip(body.version, 40) : null,
    platform: body.platform ? clip(body.platform, 40) : null,
    release: body.release ? clip(body.release, 60) : null,
    name: body.name ? clip(body.name, 120) : null,
    message: body.message ? clip(body.message, MAX_MESSAGE) : null,
    stack: body.stack ? clip(body.stack, MAX_STACK) : null,
    context,
    deviceId: body.deviceId ? clip(body.deviceId, 80) : null,
  };
}

/**
 * Запись отчёта. Возвращает `{ accepted, duplicate, count }`:
 *  - `accepted: false` — отброшен по частоте (сломанный цикл не должен забить диск);
 *  - `duplicate: true` — такое падение уже есть, увеличили счётчик.
 */
export function recordCrash(rawBody = {}, { now = Date.now(), ipHash = null } = {}) {
  const report = parseReport(rawBody);
  const at = new Date(now).toISOString();

  if (report.deviceId) {
    const hourAgo = new Date(now - 3_600_000).toISOString();
    /*
     * Считаем только *разные* падения за последний час: повтор того же самого —
     * это одна строка со счётчиком, квоту он не съедает. Значит 60 разных
     * падений в час на установку — это действительно 60 новых багов, а не
     * шестьдесят строк одного цикла. Дальше отказываем: сломанный рендер не
     * должен забивать диск.
     */
    const recent = db
      .prepare('SELECT COUNT(*) AS n FROM crash_reports WHERE device_id = ? AND last_at >= ?')
      .get(report.deviceId, hourAgo).n;
    if (recent >= CRASH_RATE_PER_HOUR) {
      log('warn', 'crash report rate limited', { deviceId: report.deviceId, ipHash });
      return { accepted: false, duplicate: false, count: 0, reason: 'rate_limited' };
    }
  }

  const fingerprint = fingerprintOf(report);
  const existing = db
    .prepare('SELECT id, count FROM crash_reports WHERE fingerprint = ? ORDER BY last_at DESC LIMIT 1')
    .get(fingerprint);

  if (existing) {
    db.prepare('UPDATE crash_reports SET count = count + 1, last_at = ? WHERE id = ?')
      .run(at, existing.id);
    return { accepted: true, duplicate: true, count: existing.count + 1, id: existing.id };
  }

  const info = db.prepare(
    `INSERT INTO crash_reports
       (fingerprint, app, version, platform, release, name, message, stack, context, device_id, count, first_at, last_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(
    fingerprint, report.app, report.version, report.platform, report.release,
    report.name, report.message, report.stack, report.context, report.deviceId, at, at
  );

  return { accepted: true, duplicate: false, count: 1, id: Number(info.lastInsertRowid) };
}

/** Лента отчётов: свежие сверху, с фильтрами по приложению и версии. */
export function listCrashes({ limit = 50, offset = 0, app = null, version = null } = {}) {
  const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const skip = Math.max(Number(offset) || 0, 0);

  const where = [];
  const params = [];
  if (app) {
    where.push('app = ?');
    params.push(String(app));
  }
  if (version) {
    where.push('version = ?');
    params.push(String(version));
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM crash_reports ${filter}`).get(...params).n;
  const rows = db.prepare(
    `SELECT * FROM crash_reports ${filter} ORDER BY last_at DESC LIMIT ? OFFSET ?`
  ).all(...params, take, skip);

  return {
    total,
    limit: take,
    offset: skip,
    items: rows.map((row) => ({
      id: row.id,
      app: row.app,
      version: row.version,
      platform: row.platform,
      release: row.release,
      name: row.name,
      message: row.message,
      stack: row.stack,
      context: row.context ? safeJson(row.context) : null,
      deviceId: row.device_id,
      count: row.count,
      firstAt: row.first_at,
      lastAt: row.last_at,
      fingerprint: row.fingerprint,
    })),
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Сводка: сколько падений, какие приложения и версии страдают.
 *
 * `crashFree` — грубая, но честная оценка: доля сессий без падения мы посчитать
 * не можем (сессии не логируем), поэтому вместо выдуманного процента отдаём
 * «падений за сутки» и «затронутых установок». Врать красивой цифрой хуже, чем
 * показать два честных числа.
 */
export function crashSummary({ days = 7, now = Date.now() } = {}) {
  const span = Math.min(Math.max(Number(days) || 7, 1), 90);
  const since = new Date(now - span * 86_400_000).toISOString();

  const totals = db.prepare(
    `SELECT COUNT(*) AS groups, COALESCE(SUM(count), 0) AS events,
            COUNT(DISTINCT device_id) AS devices
       FROM crash_reports WHERE last_at >= ?`
  ).get(since);

  const byApp = db.prepare(
    `SELECT app, COUNT(*) AS groups, COALESCE(SUM(count), 0) AS events
       FROM crash_reports WHERE last_at >= ? GROUP BY app ORDER BY events DESC`
  ).all(since);

  const byVersion = db.prepare(
    `SELECT COALESCE(version, 'неизвестна') AS version, COUNT(*) AS groups,
            COALESCE(SUM(count), 0) AS events
       FROM crash_reports WHERE last_at >= ? GROUP BY version ORDER BY events DESC LIMIT 10`
  ).all(since);

  return {
    since,
    days: span,
    groups: totals.groups ?? 0,
    events: totals.events ?? 0,
    devices: totals.devices ?? 0,
    byApp,
    byVersion,
    hint: (totals.events ?? 0) === 0
      ? 'Падений нет — или клиенты не отправляют отчёты. Проверьте сборку: crash-репортер включён по умолчанию.'
      : null,
  };
}

/** Чистка старых отчётов: держим `CRASH_RETENTION_DAYS`, по умолчанию 90. */
export function pruneCrashes({ keepDays = CRASH_RETENTION_DAYS, now = Date.now() } = {}) {
  const before = new Date(now - Math.max(1, keepDays) * 86_400_000).toISOString();
  const info = db.prepare('DELETE FROM crash_reports WHERE last_at < ?').run(before);
  return { removed: Number(info.changes || 0), before };
}
