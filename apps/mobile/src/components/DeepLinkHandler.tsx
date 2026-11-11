import { useEffect, useRef } from 'react';
import { Linking } from 'react-native';
import { parseIncoming, type MobileTarget } from '../lib/deeplink';
import type { PlayerValue } from '../player';
import type { Track } from '@vision/shared';

/**
 * Обработчик входящих ссылок (F5).
 *
 * Задача одна: `visionaudio://track/<id>?t=90` из чата должен включить трек, а не
 * открыть приложение «где-то в библиотеке». Поэтому:
 *  - обрабатываем и «холодный» старт (`getInitialURL`), и ссылку в уже открытом
 *    приложении (`url`-событие);
 *  - каждый адрес обрабатываем один раз — повторный `url`-эвент не должен
 *    перебрасывать позицию в начало;
 *  - если трека нет в библиотеке (удалён или другая сеть), ничего не ломаем:
 *    приложение остаётся на библиотеке.
 */
export function DeepLinkHandler({
  tracks,
  player,
  onShareIntent,
}: {
  tracks: Track[];
  player: PlayerValue;
  /** `visionaudio://share` — открыть диалог загрузки */
  onShareIntent?: () => void;
}) {
  const handled = useRef<string | null>(null);
  /** треки и плеер меняются на каждом рендере — держим свежие значения в ссылке */
  const latest = useRef({ tracks, player, onShareIntent });
  latest.current = { tracks, player, onShareIntent };

  useEffect(() => {
    const open = (url: string | null) => {
      if (!url || handled.current === url) return;
      handled.current = url;
      const target: MobileTarget | null = parseIncoming(url);
      if (!target) return;
      if (target.kind === 'share') {
        latest.current.onShareIntent?.();
        return;
      }

      const { tracks: list, player: p } = latest.current;
      if (target.kind === 'playlist') {
        // плейлист открывается списком; автозапуск — по параметру ?play=1
        if (target.autoplay) {
          const first = list.find((track) => track.id === target.id);
          if (first) p.playTrack(first, list);
        }
        return;
      }

      const track = list.find((item) => item.id === target.id);
      if (!track) return;
      if (target.at !== null) p.seekTo(0);
      p.playTrack(track, list);
      if (target.at) {
        // позиция появится после загрузки метаданных — ставим дважды, как только
        // плеер сообщит длительность; для коротких треков достаточно задержки
        setTimeout(() => p.seekTo(target.at ?? 0), 700);
      }
    };

    const subscription = Linking.addEventListener('url', (event) => open(event.url));
    void Linking.getInitialURL().then(open).catch(() => {});
    return () => subscription.remove();
  }, []);

  return null;
}
