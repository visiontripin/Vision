import { NativeModules } from 'react-native';
import {
  DEFAULT_PORT,
  HEALTH_TIMEOUT_MS,
  LOOPBACK_HOST,
  isHealthy,
  parseServerState,
  type ServerPhase,
  type ServerStatus,
} from './lib/embedded-server';

/**
 * Мост к встроенному Node-рантайму (`VisionNodeService`, отдельный Android-процесс).
 *
 * Best effort: если нативной части в сборке нет (обычный APK без Node, iOS,
 * Expo Go), функции возвращают `unavailable`, и локальный плеер продолжает
 * работать. Нативный сервер никогда не запускается в процессе React Native.
 */

type NativeNodeModule = {
  isAvailable?: () => Promise<boolean> | boolean;
  startServer?: (options: { port?: number; dataDir?: string; public?: boolean; token?: string }) => Promise<string>;
  stopServer?: () => Promise<boolean>;
  readState?: () => Promise<{ state?: string | null }>;
  runtimeVersion?: () => Promise<string>;
};

/**
 * `NativeModules.VisionNode` появляется только если нативный модуль собран и
 * зарегистрирован. Доступ через try/catch: в тестах/web-таргете `NativeModules`
 * может отсутствовать целиком.
 */
export function nativeNode(): NativeNodeModule | null {
  try {
    const candidate = (NativeModules as Record<string, unknown> | undefined)?.VisionNode;
    return candidate ? (candidate as NativeNodeModule) : null;
  } catch {
    return null;
  }
}

export function isRuntimeAvailable(): boolean {
  const native = nativeNode();
  return Boolean(native?.startServer);
}

/** Проверяет наличие библиотек в APK, не загружая их в процесс приложения. */
export async function checkRuntimeAvailable(): Promise<boolean> {
  const native = nativeNode();
  if (!native?.startServer) return false;
  try {
    return native.isAvailable ? Boolean(await native.isAvailable()) : true;
  } catch {
    return false;
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Проверяем именно HTTP health, а не то, что Android принял Intent сервиса. */
async function waitForHealth(url: string, timeoutMs: number): Promise<{
  ok: boolean;
  runtime: string | null;
  version: string | null;
  error: string | null;
}> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'нет ответа';

  while (Date.now() < deadline) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const abortTimer = controller ? setTimeout(() => controller.abort(), 700) : null;
    try {
      const response = await fetch(`${url.replace(/\/+$/, '')}/api/health`, {
        method: 'GET',
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (response.ok) {
        const payload: unknown = await response.json();
        if (isHealthy(payload)) {
          const value = payload as Record<string, unknown>;
          return {
            ok: true,
            runtime: typeof value.runtime === 'string' ? value.runtime : null,
            version: typeof value.version === 'string' ? value.version : null,
            error: null,
          };
        }
        lastError = 'health ответил без признака ok';
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
    }

    const state = await readServerState();
    if (state?.phase === 'failed') {
      return {
        ok: false,
        runtime: state.runtime,
        version: null,
        error: state.error ?? lastError,
      };
    }
    await wait(150);
  }

  const state = await readServerState();
  return {
    ok: false,
    runtime: state?.runtime ?? null,
    version: null,
    error: state?.phase === 'failed'
      ? state.error ?? 'сервер завершился с ошибкой'
      : `сервер не ответил за ${timeoutMs} мс (${lastError})`,
  };
}

/**
 * Запускает сервер и ждёт, пока `/api/health` реально ответит.
 *
 * Адрес из NativeModule означает только «Android принял запрос на запуск». Node
 * поднимается в отдельном процессе асинхронно, поэтому успех подтверждает только
 * HTTP health-check. Если серверный процесс упадёт, приложение при этом остаётся
 * живым и может продолжать воспроизведение.
 */
export async function startEmbeddedServer(options: {
  port?: number;
  dataDir?: string;
  public?: boolean;
  token?: string | null;
  onPhase?: (phase: ServerPhase, error?: string | null) => void;
} = {}): Promise<ServerStatus> {
  const native = nativeNode();
  const port = options.port ?? DEFAULT_PORT;
  const base: ServerStatus = {
    phase: 'stopped',
    url: null,
    port,
    runtime: null,
    error: null,
    at: Date.now(),
  };

  if (!native?.startServer || !(await checkRuntimeAvailable())) {
    options.onPhase?.('unavailable');
    return { ...base, phase: 'unavailable' };
  }

  options.onPhase?.('starting');
  try {
    const reported = await native.startServer({
      port,
      dataDir: options.dataDir,
      public: options.public ?? false,
      token: options.token ?? undefined,
    });
    if (typeof reported !== 'string' || !/^https?:\/\//.test(reported)) {
      const error = reported || 'рантайм не ответил адресом';
      options.onPhase?.('failed', error);
      return { ...base, phase: 'failed', error, at: Date.now() };
    }

    const health = await waitForHealth(reported, HEALTH_TIMEOUT_MS);
    if (!health.ok) {
      options.onPhase?.('failed', health.error);
      return { ...base, phase: 'failed', url: null, runtime: health.runtime, error: health.error, at: Date.now() };
    }

    const runtime = health.runtime ?? (await runtimeVersion()) ?? null;
    options.onPhase?.('running');
    return {
      ...base,
      phase: 'running',
      url: reported,
      runtime,
      at: Date.now(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onPhase?.('failed', message);
    return { ...base, phase: 'failed', error: message, at: Date.now() };
  }
}

export async function stopEmbeddedServer(): Promise<void> {
  try {
    await nativeNode()?.stopServer?.();
  } catch {
    /* остановка — не та операция, из-за которой стоит падать */
  }
}

/** Версия рантайма (`v24.22.3`) — из `state.json`, JNI её не знает. */
export async function runtimeVersion(): Promise<string | null> {
  const state = await readServerState();
  return state?.runtime ?? null;
}

/** Читает `state.json`, который пишет `bootstrap.mjs`. */
export async function readServerState(): Promise<{
  phase: ServerPhase;
  error: string | null;
  runtime: string | null;
  port: number | null;
  url: string | null;
  at: number | null;
} | null> {
  try {
    const raw = await nativeNode()?.readState?.();
    return parseServerState(raw?.state ?? null);
  } catch {
    return null;
  }
}

/** Адрес работающего сервера — или null, если он не поднят. */
export function localServerUrl(port: number = DEFAULT_PORT): string {
  return `http://${LOOPBACK_HOST}:${port}`;
}
