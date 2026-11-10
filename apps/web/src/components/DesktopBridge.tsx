import { useEffect } from 'react';
import { usePlayer } from '../state/player';
import { isDesktop, listenDesktop, publishDesktopState } from '../desktop';

/**
 * Связка плеера с нативной оболочкой (Tauri): медиа-клавиши и пункты меню в трее
 * управляют воспроизведением, а состояние плеера уходит обратно в трей.
 *
 * В браузере компонент ничего не делает — ни подписок, ни запросов.
 */
export function DesktopBridge() {
  const player = usePlayer();

  useEffect(() => {
    if (!isDesktop()) return;
    return listenDesktop({ toggle: player.toggle, next: player.next, prev: player.prev });
  }, [player.toggle, player.next, player.prev]);

  useEffect(() => {
    if (!isDesktop()) return;
    publishDesktopState(player.current, player.playing);
  }, [player.current, player.playing]);

  return null;
}
