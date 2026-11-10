import type { Track } from '@vision/shared';

/**
 * Мост между web-бандлом и Rust-оболочкой Tauri.
 *
 * Десктопное приложение — это тот же интерфейс, но с нативными возможностями:
 * глобальные медиа-клавиши и меню в системном трее приходят из Rust событиями
 * `media:*`, а состояние плеера уезжает обратно, чтобы трей показывал трек и
 * правильную подпись пункта «Играть/Пауза».
 *
 * В браузере и на GitHub Pages мост молчит: `isDesktop()` = false, никаких
 * импортов нативного API в рантайме.
 */

type PlayerHandlers = {
  toggle: () => void;
  next: () => void;
  prev: () => void;
};

export type DesktopState = {
  playing: boolean;
  title: string | null;
  artist: string | null;
};

/** Запущены ли мы внутри Tauri (а не в обычной вкладке). */
export function isDesktop(): boolean {
  if (typeof window === 'undefined') return false;
  const internals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  return Boolean(internals);
}

/**
 * Подписка на команды из трея и глобальных клавиш.
 * Возвращает функцию отписки; в браузере — no-op.
 */
export function listenDesktop(handlers: PlayerHandlers): () => void {
  if (!isDesktop()) return () => {};

  let disposed = false;
  const unlisten: Array<() => void> = [];

  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const bindings: Array<[string, () => void]> = [
        ['media:play-pause', handlers.toggle],
        ['media:next', handlers.next],
        ['media:prev', handlers.prev],
      ];
      for (const [event, handler] of bindings) {
        const off = await listen(event, () => handler());
        if (disposed) off();
        else unlisten.push(off);
      }
    } catch {
      /* сборка без @tauri-apps/api или окно уже закрыто — не критично */
    }
  })();

  return () => {
    disposed = true;
    for (const off of unlisten) {
      try {
        off();
      } catch {
        /* noop */
      }
    }
    unlisten.length = 0;
  };
}

/** Отправить состояние плеера в трей (подпись пункта меню и tooltip). */
export function publishDesktopState(track: Track | null, playing: boolean): void {
  if (!isDesktop()) return;
  void (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('player_state', {
        playing,
        title: track?.title ?? null,
        artist: track?.artist ?? null,
      });
    } catch {
      /* окно закрывается или команда недоступна */
    }
  })();
}
