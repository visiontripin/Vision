/**
 * Аудит действий (Фаза 6, G10) — `docs/API.md`, раздел «Аудит действий».
 *
 * Задача узкая: ответить на вопрос «кто это сделал», когда ответ уже нужен.
 * Поэтому:
 *  - пишем в БД (переживает рестарт, попадает в бэкап), а не только в stdout;
 *  - журнал читается лентой с фильтрами, а не grep по логам;
 *  - персональных данных нет: `ip_hash = sha256(secret + ip)`, тот же, что в `share_hits`;
 *  - токены ссылок не пишутся никогда — только `share_id`;
 *  - гостевые визиты схлопываются в окне 10 минут: журнал должен отвечать на вопрос,
 *    а не перечислять обновления страницы;
 *  - `AUDIT_ENABLED=0` выключает запись (чтение остаётся), `AUDIT_RETENTION_DAYS`
 *    задаёт срок хранения.
 *
 * Ошибка записи никогда не ломает основной запрос: аудит вторичен по отношению к
 * действию, которое он описывает (удалить трек важнее, чем записать, что его удалили).
 */
import { createHash } from 'node:crypto';

import { db } from './db.js';
import { log } from './lib.js';

const DEDUPE_WINDOW_MS = 10 * 60_000;
const MAX_DETAILS_BYTES = 2048;

export const AUDIT_ENABLED = process.env.AUDIT_ENABLED !== '0';
export const AUDIT_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.AUDIT_RETENTION_DAYS || 180)
);

/** Справочник действий: код + подпись для человека + актор по умолчанию. */
export const AUDIT_ACTIONS = {
  'track.upload': { label: 'загружен трек', actor: 'owner', target: 'track' },
  'track.update': { label: 'изменён трек', actor: 'owner', target: 'track' },
  'track.delete': { label: 'удалён трек', actor: 'owner', target: 'track' },
  'playlist.create': { label: 'создан плейлист', actor: 'owner', target: 'playlist' },
  'playlist.update': { label: 'изменён плейлист', actor: 'owner', target: 'playlist' },
  'playlist.delete': { label: 'удалён плейлист', actor: 'owner', target: 'playlist' },
  'share.create': { label: 'выпущена ссылка', actor: 'owner', target: 'share' },
  'share.revoke': { label: 'ссылка отозвана', actor: 'owner', target: 'share' },
  'share.rotate': { label: 'ссылка перевыпущена', actor: 'owner', target: 'share' },
  'share.delete': { label: 'ссылка удалена', actor: 'owner', target: 'share' },
  'comment.add': { label: 'комментарий к секунде', actor: 'guest', target: 'comment' },
  'comment.delete': { label: 'комментарий удалён', actor: 'guest', target: 'comment' },
  'share.open': { label: 'открыта ссылка', actor: 'guest', target: 'share' },
  'share.stream': { label: 'прослушивание по ссылке', actor: 'guest', target: 'share' },
  'share.download': { label: 'скачивание по ссылке', actor: 'guest', target: 'share' },
  'auth.login': { label: 'вход владельца', actor: 'owner', target: 'system' },
  'auth.fail': { label: 'неудачная попытка входа', actor: 'system', target: 'system' },
  'migration.apply': { label: 'применена миграция', actor: 'system', target: 'system' },
  'server.start': { label: 'сервер запущен', actor: 'system', target: 'system' },
  'audit.prune': { label: 'журнал очищен', actor: 'owner', target: 'system' },
  'backup.create': { label: 'создана резервная копия', actor: 'owner', target: 'system' },
  'backup.verify': { label: 'проверено восстановление', actor: 'owner', target: 'system' },
  'crashes.prune': { label: 'отчёты о падениях очищены', actor: 'owner', target: 'system' },
};

export const AUDIT_ACTOR_LABELS = {
  owner: 'владелец',
  guest: 'гость',
  system: 'система',
};

/** Действия, которые дублируются при обновлении страницы — схлопываем. */
const COLLAPSED = new Set(['share.open', 'share.stream', 'share.download']);

function trimDetails(details) {
  if (!details || typeof details !== 'object') return null;
  const text = JSON.stringify(details);
  if (Buffer.byteLength(text) <= MAX_DETAILS_BYTES) return text;
  return JSON.stringify({ truncated: true });
}

/**
 * Запись события. `actor` по умолчанию берётся из справочника, `ip_hash` —
 * готовый хеш (вычислять адрес внутри модуля нельзя: он приходит из запроса).
 */
export function audit(action, {
  actor = AUDIT_ACTIONS[action]?.actor ?? 'system',
  targetKind = AUDIT_ACTIONS[action]?.target ?? null,
  targetId = null,
  shareId = null,
  ipHash = null,
  requestId = null,
  details = null,
  at = new Date(),
} = {}) {
  if (!AUDIT_ENABLED) return null;
  const iso = at.toISOString();
  try {
    if (COLLAPSED.has(action) && ipHash) {
      // повтор того же гостя в окне 10 минут: не новая строка, а счётчик
      const existing = db
        .prepare(
          `SELECT id, details FROM audit_log
            WHERE action = ? AND actor = ? AND ip_hash = ?
              AND share_id IS ? AND at > ?
            ORDER BY at DESC LIMIT 1`
        )
        .get(action, actor, ipHash, shareId, new Date(at.getTime() - DEDUPE_WINDOW_MS).toISOString());
      if (existing) {
        const parsed = safeParse(existing.details) || {};
        const repeat = Number(parsed.repeat || 1) + 1;
        db.prepare('UPDATE audit_log SET at = ?, details = ? WHERE id = ?')
          .run(iso, trimDetails({ ...parsed, repeat }), existing.id);
        return existing.id;
      }
    }

    const info = db
      .prepare(
        `INSERT INTO audit_log (at, actor, action, target_kind, target_id, share_id, ip_hash, request_id, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(iso, actor, action, targetKind, targetId, shareId, ipHash, requestId, trimDetails(details));
    return Number(info.lastInsertRowid);
  } catch (error) {
    // журнал не должен ронять действие, которое описывает
    log('error', 'audit write failed', { action, error: error?.message || String(error) });
    return null;
  }
}

function safeParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Готовая подпись: «владелец удалил трек “Ночь”». */
export function auditLabel(row) {
  const action = AUDIT_ACTIONS[row.action];
  const actor = AUDIT_ACTOR_LABELS[row.actor] || row.actor;
  const title = safeParse(row.details)?.title;
  const base = action ? action.label : row.action;
  return title ? `${actor} · ${base} «${title}»` : `${actor} · ${base}`;
}

function rowToEntry(row) {
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    label: auditLabel(row),
    targetKind: row.target_kind,
    targetId: row.target_id,
    shareId: row.share_id,
    ipHash: row.ip_hash,
    requestId: row.request_id,
    details: safeParse(row.details),
  };
}

/**
 * Лента журнала, новые сверху. Фильтры складываются по «И»; `limit` ограничен
 * сотней — это инструмент разбора, а не выгрузка всей истории.
 */
export function listAudit({
  limit = 100,
  offset = 0,
  action = null,
  actor = null,
  shareId = null,
  since = null,
  until = null,
} = {}) {
  const where = [];
  const params = [];
  if (action) {
    // поддерживаем и точное действие, и группу: `track` → `track.%`
    if (String(action).includes('*') || !String(action).includes('.')) {
      where.push('action LIKE ?');
      params.push(`${String(action).replace(/[^a-z.]/gi, '')}%`);
    } else {
      where.push('action = ?');
      params.push(action);
    }
  }
  if (actor) {
    where.push('actor = ?');
    params.push(actor);
  }
  if (shareId) {
    where.push('share_id = ?');
    params.push(shareId);
  }
  if (since) {
    where.push('at >= ?');
    params.push(String(since));
  }
  if (until) {
    where.push('at <= ?');
    params.push(String(until));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const take = Math.min(Math.max(Number(limit) || 100, 1), 100);
  const skip = Math.max(Number(offset) || 0, 0);

  const entries = db
    .prepare(`SELECT * FROM audit_log ${clause} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, take, skip)
    .map(rowToEntry);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(...params).n;
  return { entries, total, limit: take, offset: skip };
}

/** Сводка для панели: сколько чего за период (по умолчанию — за сутки). */
export function auditSummary({ days = 1 } = {}) {
  const since = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT action, actor, COUNT(*) AS n FROM audit_log
        WHERE at >= ? GROUP BY action, actor ORDER BY n DESC`
    )
    .all(since);
  const byActor = { owner: 0, guest: 0, system: 0 };
  for (const row of rows) byActor[row.actor] = (byActor[row.actor] || 0) + row.n;
  return {
    since,
    total: rows.reduce((sum, row) => sum + row.n, 0),
    byActor,
    actions: rows.map((row) => ({ action: row.action, actor: row.actor, count: row.n })),
  };
}

/** Чистка старых записей: `keepDays` по умолчанию — `AUDIT_RETENTION_DAYS`. */
export function pruneAudit({ keepDays = AUDIT_RETENTION_DAYS } = {}) {
  const days = Math.max(1, Number(keepDays) || AUDIT_RETENTION_DAYS);
  const before = new Date(Date.now() - days * 86_400_000).toISOString();
  const info = db.prepare('DELETE FROM audit_log WHERE at < ?').run(before);
  return { removed: Number(info.changes || 0), before };
}

/** Хеш адреса для журнала: тот же алгоритм, что у `share_hits` (`shares.ipHash`). */
export function auditIpHash(ip, secret = process.env.VISION_SECRET || 'vision') {
  if (!ip) return null;
  return createHash('sha256').update(`${secret}:${ip}`).digest('hex').slice(0, 32);
}
