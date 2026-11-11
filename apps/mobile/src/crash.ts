import { Platform } from 'react-native';
import { createCrashReporter } from '@vision/shared';

/**
 * Crash-репортинг мобильного приложения (Фаза 3, H5).
 *
 * Ловим то, что реально ломает приложение на телефоне:
 *  - исключения JS (`ErrorUtils.setGlobalHandler`) — включая ошибки в рендере;
 *  - необработанные отказы промисов (сеть, файлы, плеер);
 *  - `console.error` как последний рубеж: React Native иногда сообщает о проблеме
 *    только туда, без исключения.
 *
 * Чего **не** делаем: не пытаемся поймать нативные падения (для этого нужен
 * Sentry/Crashlytics с NDK-хуком) и не отправляем отчёт в цикле — на сервере
 * стоит лимит 60 в час на установку.
 */

type GlobalWithErrorUtils = typeof globalThis & {
  ErrorUtils?: {
    getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void;
    setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
  };
};

export function installCrashReporter(options: {
  getBaseUrl: () => string;
  version: string;
  deviceId?: string;
}) {
  const reporter = createCrashReporter(options.getBaseUrl, {
    app: 'mobile',
    version: options.version,
    platform: Platform.OS,
    release: String(Platform.Version ?? ''),
    deviceId: options.deviceId,
    // В контексте — только «где были», без содержимого библиотеки: отчёт не
    // должен превращаться в копию данных человека.
    context: () => ({ platform: Platform.OS, version: options.version }),
  });

  const global = globalThis as GlobalWithErrorUtils;
  const previous = global.ErrorUtils?.getGlobalHandler?.();

  global.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
    reporter.capture(error);
    // прежний обработчик (красный экран в dev, закрытие в проде) не отменяем
    previous?.(error, isFatal);
  });

  // Отказы промисов не роняют приложение, но именно они чаще всего ломают плеер.
  if (typeof (globalThis as any).addEventListener === 'function') {
    (globalThis as any).addEventListener('unhandledrejection', (event: { reason?: unknown }) => {
      reporter.capture(event?.reason ?? new Error('unhandled rejection'));
    });
  }

  return {
    capture: reporter.capture,
    flush: reporter.flush,
    queued: reporter.queued,
    reporter,
  };
}
