import { NativeModules } from 'react-native';
import { DEFAULT_PORT, LOOPBACK_HOST, parseServerState, type ServerPhase, type ServerStatus } from './lib/embedded-server';

/**
 * Мост к встроенному Node-рантайму (`VisionNode.java` в android-проекте).
 *
 * Работает по принципу «best effort»: если нативной части в сборке нет (обычный
 * APK без Node, iOS, Expo Go), все функции просто возвращают
 * `phase: 'unavailable'` — приложение обязано работать дальше как локальный
 * плеер. Ни одна ветка ниже не бросает исключение наружу, иначе сломанный
 * рантайм утащит за собой весь экран.
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
 * зарегистрирован. Доступ через try/catch: в тестах и на веб-таргете
 * `NativeModules` может отсутствовать целиком.
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
  return nativeNode() !== null;
}

/**
 * Запускает сервер и ждёт, пока он реально начнёт отвечать.
 *
 * Приложение не должно показывать «сервер работает» сразу после вызова
 * `startServer`: процесс поднимается асинхронно. Поэтому состояние сервера —
 * единственный источник правды, а строка ниже лишь просит его запустить.
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

  if (!native?.startServer) {
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
    // Нативная часть возвращает либо адрес, либо код ошибки (`EADDRINUSE: …`).
    if (typeof reported === 'string' && /^https?:\/\//.test(reported)) {
      options.onPhase?.('running');
      return { ...base, phase: 'running', url: reported, runtime: (await runtimeVersion()) ?? null, at: Date.now() };
    }
    const error = reported || 'рантайм не ответил адресом';
    options.onPhase?.('failed', error);
    return { ...base, phase: 'failed', error, at: Date.now() };
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

/**
 * Читает `state.json`, который пишет `bootstrap.mjs`.
 *
 * Это второй, независимый от JNI источник правды: если процесс упал уже после
 * старта, `startServer` об этом не узнает, а файл — узнает.
 */
export async function readServerState(): Promise<{ phase: ServerPhase; error: string | null; runtime: string | null } | null> {
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
