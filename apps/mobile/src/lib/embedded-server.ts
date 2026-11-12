/**
 * Встроенный сервер на телефоне: параметры запуска, состояния и адреса.
 *
 * Здесь только чистая логика — никаких `node:` и `react-native`-импортов, чтобы
 * файл проверялся обычным `node:test` и годился и для Node-рантайма на телефоне,
 * и для экрана диагностики.
 *
 * Зачем вообще сервер в приложении: приложение умеет работать без внешнего
 * сервера — лента, плеер и файлы живут на телефоне. Встроенный сервер добавляет
 * то, чего без него нет: полный HTTP API на устройстве (`/api/health`,
 * библиотека, статистика) и возможность отдать треки другому устройству в той же
 * сети. Общая библиотека «из любой сети» при этом остаётся на реестре (вариант D).
 */

/** Порт по умолчанию. 4000 занят домашним сервером — на телефоне берём соседний. */
export const DEFAULT_PORT = 4000;

/** Сколько ждать ответа `/api/health`, прежде чем считать сервер не поднявшимся. */
export const HEALTH_TIMEOUT_MS = 4000;

/** Верхняя граница автоподбора: 4000…4010, дальше — уже странно. */
export const MAX_PORT_OFFSET = 10;

/**
 * Откуда берётся версия Node для экрана диагностики.
 *
 * JNI её не знает (рантайм живёт в своём потоке), поэтому единственный источник —
 * `state.json`, который пишет `bootstrap.mjs`. Отдельная функция, чтобы не
 * забыть это правило в экранах.
 */
export function runtimeFromState(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as Record<string, unknown>).runtime;
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Разбирает `state.json` в состояние экрана; мусор не должен ломать UI. */
export function parseServerState(raw: string | null | undefined): {
  phase: ServerPhase;
  error: string | null;
  runtime: string | null;
  port: number | null;
  url: string | null;
  at: number | null;
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const phases: ServerPhase[] = ['unavailable', 'stopped', 'starting', 'running', 'failed'];
    const phase = typeof parsed.phase === 'string' && phases.includes(parsed.phase as ServerPhase)
      ? parsed.phase as ServerPhase
      : 'stopped';
    const port = Number(parsed.port);
    const at = Number(parsed.at);
    return {
      phase,
      error: typeof parsed.error === 'string' ? parsed.error : null,
      runtime: runtimeFromState(parsed),
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
      url: typeof parsed.url === 'string' && /^https?:\/\//i.test(parsed.url) ? parsed.url : null,
      at: Number.isFinite(at) && at > 0 ? at : null,
    };
  } catch {
    return null;
  }
}

export type ServerPhase =
  /** рантайма нет в сборке (обычный APK без встроенного Node) */
  | 'unavailable'
  /** ещё не запускали */
  | 'stopped'
  /** процесс поднимается */
  | 'starting'
  /** `/api/health` ответил 200 */
  | 'running'
  /** запускали, но не поднялся */
  | 'failed';

export interface ServerStatus {
  phase: ServerPhase;
  /** `http://127.0.0.1:4000`, пока сервер не запущен — null */
  url: string | null;
  port: number;
  /** версия рантайма, например `v24.22.3` */
  runtime: string | null;
  /** последняя строка ошибки для экрана диагностики */
  error: string | null;
  /** когда последний раз менялось состояние (мс, epoch) */
  at: number;
}

export const EMPTY_STATUS: ServerStatus = {
  phase: 'stopped',
  url: null,
  port: DEFAULT_PORT,
  runtime: null,
  error: null,
  at: 0,
};

/** Слушать только петлю: наружу ничего не торчит без явного разрешения. */
export const LOOPBACK_HOST = '127.0.0.1';

/**
 * Адрес сервера для приложения и для `WebView`-тестера.
 *
 * `127.0.0.1` вместо `localhost` — намеренно: на Android `localhost` иногда
 * резолвится в `::1`, а слушаем мы только IPv4-петлю.
 */
export function serverUrl(port: number = DEFAULT_PORT): string {
  return `http://${LOOPBACK_HOST}:${port}`;
}

/** Разбирает адрес на порт; мусор и нестандартные схемы дают null. */
export function parsePort(url: string | null | undefined): number | null {
  const value = String(url ?? '').trim();
  if (!value) return null;
  const match = /^https?:\/\/[^/:]+:(\d{1,5})(?:\/|$)/i.exec(value);
  if (!match) return /^https?:\/\/[^/]+$/i.test(value) ? 80 : null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * Следующий порт для попытки: 4000, 4001, … 4010, потом null.
 *
 * Порт на телефоне может быть занят (второй экземпляр приложения, чужой сервер) —
 * поэтому при отказе `listen` пробуем соседний, а не падаем.
 */
export function nextPort(tried: Iterable<number>, start = DEFAULT_PORT, maxOffset = MAX_PORT_OFFSET): number | null {
  const used = new Set<number>(tried);
  for (let offset = 0; offset <= maxOffset; offset += 1) {
    const port = start + offset;
    if (!used.has(port)) return port;
  }
  return null;
}

/**
 * Что делать с упавшим запуском: пробовать ещё порт или сдаваться.
 *
 * Отдельная функция, потому что правило важное и легко сломать: `EADDRINUSE`
 * лечится сменой порта, остальные ошибки (нет бинарника, битый бандл) — нет, и
 * повторять их бессмысленно.
 */
export type FailureAction = 'retry' | 'give-up';

export function failureAction(error: string | null | undefined, triedCount: number): FailureAction {
  const message = String(error ?? '');
  if (triedCount > MAX_PORT_OFFSET) return 'give-up';
  return /EADDRINUSE|address already in use/i.test(message) ? 'retry' : 'give-up';
}

/** Человеческое состояние для экрана диагностики. */
export function describeStatus(status: ServerStatus): { title: string; detail: string } {
  switch (status.phase) {
    case 'running':
      return {
        title: 'Сервер работает',
        detail: `${status.url ?? serverUrl(status.port)} · ${status.runtime ?? 'рантайм не определён'}`.trim(),
      };
    case 'starting':
      return { title: 'Сервер запускается', detail: `порт ${status.port}` };
    case 'failed':
      return { title: 'Сервер не запустился', detail: status.error ?? 'причина неизвестна' };
    case 'unavailable':
      return {
        title: 'Встроенный сервер недоступен',
        detail: 'эта сборка без рантайма: работают лента, плеер и синхронизация',
      };
    default:
      return { title: 'Сервер остановлен', detail: 'запускается из настроек или при старте приложения' };
  }
}

/** Можно ли показывать ссылку на панель/тестер: только у работающего сервера. */
export function isReachable(status: ServerStatus): boolean {
  return status.phase === 'running' && Boolean(status.url);
}

/**
 * Ожидаемый ответ `/api/health` для встроенного сервера.
 *
 * Тот же контракт, что у домашнего сервера (`docs/API.md`), плюс признаки
 * встроенного запуска — по ним тестер отличает «сервер на телефоне» от «сервер
 * на компьютере, введённый вручную».
 */
export interface HealthPayload {
  ok: boolean;
  version?: string;
  runtime?: string;
  embedded?: boolean;
  [key: string]: unknown;
}

export function isHealthy(payload: unknown): payload is HealthPayload {
  if (!payload || typeof payload !== 'object') return false;
  const value = payload as Record<string, unknown>;
  return value.ok === true || value.status === 'ok';
}

/**
 * Строка сводки для тестера: одна строка, которую не стыдно скопировать в отчёт.
 */
export function summaryLine(args: {
  phase: ServerPhase;
  url: string | null;
  runtime: string | null;
  version?: string | null;
}): string {
  const parts = [`${args.phase}`, args.url ?? 'без адреса'];
  if (args.runtime) parts.push(args.runtime);
  if (args.version) parts.push(`v${args.version}`);
  return parts.join(' · ');
}

/**
 * Проверка «сервер на телефоне — источник правды»: общая библиотека (вариант D)
 * остаётся включённой, даже когда локальный сервер поднялся. Иначе получится
 * ровно то, от чего уходили: одна сеть работает, другая нет.
 */
export function libraryMode(status: ServerStatus, registryEnabled: boolean): string {
  if (!registryEnabled) {
    return status.phase === 'running'
      ? 'только этот телефон: сервер поднят, общая библиотека выключена'
      : 'только этот телефон';
  }
  return status.phase === 'running'
    ? 'общая библиотека + сервер на телефоне'
    : 'общая библиотека (реестр)';
}
