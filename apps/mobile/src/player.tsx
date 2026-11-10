import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { Audio, type AVPlaybackStatus } from 'expo-av';
import type { Track } from '@vision/shared';
import { api } from './api';
import { useDownloads } from './downloads';
import { shuffleIndices, stepPosition, type Repeat } from './lib/queue';

/**
 * Плеер приложения: один `Audio.Sound` на всё приложение, очередь, повтор,
 * перемешивание и фоновое воспроизведение.
 *
 * Источник звука: сначала скачанный файл (офлайн), иначе подписанная ссылка с
 * сервера. На мобильных предпочитаем AAC (`streams.aac`) — его понимают и
 * AVPlayer, и ExoPlayer; opus в ogg на iOS ненадёжен.
 */

type PlayerValue = {
  queue: Track[];
  current: Track | null;
  playing: boolean;
  buffering: boolean;
  position: number;
  duration: number;
  repeat: Repeat;
  shuffle: boolean;
  error: string | null;
  playTrack: (track: Track, list?: Track[]) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seekTo: (seconds: number) => void;
  seekBy: (delta: number) => void;
  cycleRepeat: () => void;
  toggleShuffle: () => void;
  stop: () => void;
};

const PlayerContext = createContext<PlayerValue | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const downloads = useDownloads();

  const [queue, setQueue] = useState<Track[]>([]);
  const [order, setOrder] = useState<number[]>([]);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [repeat, setRepeatState] = useState<Repeat>('off');
  const [shuffle, setShuffle] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const soundRef = useRef<Audio.Sound | null>(null);
  const audioModeReady = useRef(false);
  const finishedRef = useRef(false);
  // позиция для отчёта о прослушивании: интервал не должен замыкаться на старое состояние
  const positionRef = useRef(0);

  const stateRef = useRef({ queue, order, pos, repeat, shuffle, playing });
  stateRef.current = { queue, order, pos, repeat, shuffle, playing };

  const current = queue[order[pos]] ?? null;

  /* ---- фоновый режим: музыка продолжает играть при выключенном экране ---- */
  useEffect(() => {
    if (audioModeReady.current) return;
    audioModeReady.current = true;
    Audio.setAudioModeAsync({
      staysActiveInBackground: true,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    } as never).catch(() => {});
  }, []);

  const unload = useCallback(async () => {
    const sound = soundRef.current;
    soundRef.current = null;
    if (!sound) return;
    try {
      await sound.stopAsync();
    } catch {
      /* уже остановлен */
    }
    await sound.unloadAsync().catch(() => {});
  }, []);

  const advance = useCallback((delta: 1 | -1, manual: boolean) => {
    const { order: currentOrder, pos: currentPos, repeat: currentRepeat } = stateRef.current;
    const target = stepPosition(currentPos, currentOrder.length, currentRepeat, delta, manual);
    if (target === null) {
      setPlaying(false);
      return;
    }
    setPos(target);
  }, []);

  const onStatus = useCallback(
    (status: AVPlaybackStatus) => {
      if (!status.isLoaded) {
        if ('error' in status && status.error) setError(status.error);
        return;
      }
      const seconds = (status.positionMillis ?? 0) / 1000;
      positionRef.current = seconds;
      setPosition(seconds);
      if (status.durationMillis) setDuration(status.durationMillis / 1000);
      setPlaying(status.isPlaying);
      setBuffering(Boolean(status.isBuffering));

      if (status.didJustFinish && !finishedRef.current) {
        finishedRef.current = true;
        const { repeat: currentRepeat } = stateRef.current;
        if (currentRepeat === 'one') {
          soundRef.current?.replayAsync().catch(() => {});
          finishedRef.current = false;
          return;
        }
        advance(1, false);
        // сбрасываем флаг после перехода, чтобы следующий трек снова мог завершиться
        setTimeout(() => {
          finishedRef.current = false;
        }, 500);
      }
    },
    [advance]
  );

  /* ---- загрузка текущего трека ---- */
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    setError(null);
    setBuffering(true);

    (async () => {
      await unload();
      if (cancelled) return;

      const local = downloads.localUri(current.id);
      let uri = local;
      if (!uri) {
        const media = await api.media([current.id]).catch(() => null);
        const item = media?.items?.[current.id];
        uri = item?.streams?.aac ?? item?.stream ?? null;
      }
      if (!uri) {
        setBuffering(false);
        setError('Сервер не выдал ссылку на трек');
        return;
      }

      try {
        const { sound } = await Audio.Sound.createAsync(
          { uri },
          { shouldPlay: stateRef.current.playing, progressUpdateIntervalMillis: 500 },
          onStatus
        );
        if (cancelled) {
          await sound.unloadAsync().catch(() => {});
          return;
        }
        soundRef.current = sound;
        setDuration((current.duration ?? 0) || 0);
        setPosition(0);
        api.registerPlay(current.id).catch(() => {});
      } catch (cause) {
        setBuffering(false);
        setError(cause instanceof Error ? cause.message : 'Не удалось воспроизвести трек');
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  /* ---- отчёт о прослушивании: питает «Продолжить слушать» в вебе ---- */
  useEffect(() => {
    if (!current || !playing) return;
    const id = current.id;
    const report = () => {
      const seconds = positionRef.current;
      if (seconds < 3) return;
      api.listen(id, { position: seconds, duration: duration || current.duration || undefined }).catch(() => {});
    };
    const timer = setInterval(report, 15000);
    return () => {
      clearInterval(timer);
      report();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, playing]);

  /* ---- управление ---- */
  const playTrack = useCallback((track: Track, list?: Track[]) => {
    const items = list && list.length ? list : [track];
    const trackIndex = Math.max(0, items.findIndex((item) => item.id === track.id));
    const nextOrder = stateRef.current.shuffle
      ? shuffleIndices(items.length, trackIndex)
      : items.map((_, index) => index);
    setQueue(items);
    setOrder(nextOrder);
    setPos(stateRef.current.shuffle ? 0 : trackIndex);
    setPlaying(true);
    if (current?.id === track.id) {
      // тот же трек уже загружен — просто продолжаем
      soundRef.current?.playAsync().catch(() => {});
    }
  }, [current?.id]);

  const toggle = useCallback(() => {
    const sound = soundRef.current;
    if (!sound) return;
    if (playing) {
      setPlaying(false);
      sound.pauseAsync().catch(() => {});
    } else {
      setPlaying(true);
      sound.playAsync().catch(() => setPlaying(false));
    }
  }, [playing]);

  const seekTo = useCallback((seconds: number) => {
    const sound = soundRef.current;
    if (!sound) return;
    const target = Math.max(0, seconds);
    positionRef.current = target;
    setPosition(target);
    sound.setPositionAsync(target * 1000).catch(() => {});
  }, []);

  const seekBy = useCallback((delta: number) => {
    setPosition((value) => {
      const target = Math.max(0, value + delta);
      soundRef.current?.setPositionAsync(target * 1000).catch(() => {});
      return target;
    });
  }, []);

  const next = useCallback(() => advance(1, true), [advance]);
  const prev = useCallback(() => advance(-1, true), [advance]);

  const cycleRepeat = useCallback(() => {
    setRepeatState((value) => (value === 'off' ? 'all' : value === 'all' ? 'one' : 'off'));
  }, []);

  const toggleShuffle = useCallback(() => {
    const { queue: currentQueue, order: currentOrder, pos: currentPos } = stateRef.current;
    const enabled = !stateRef.current.shuffle;
    setShuffle(enabled);

    if (!currentQueue.length) return;
    if (enabled) {
      const currentTrackIndex = currentOrder[currentPos] ?? 0;
      setOrder(shuffleIndices(currentQueue.length, currentTrackIndex));
      setPos(0);
    } else {
      const currentTrackIndex = currentOrder[currentPos] ?? 0;
      setOrder(currentQueue.map((_, index) => index));
      setPos(currentTrackIndex);
    }
  }, []);

  const stop = useCallback(() => {
    void unload();
    setQueue([]);
    setOrder([]);
    setPos(0);
    setPlaying(false);
    setPosition(0);
    setDuration(0);
  }, [unload]);

  useEffect(() => () => void unload(), [unload]);

  const value = useMemo<PlayerValue>(
    () => ({
      queue,
      current,
      playing,
      buffering,
      position,
      duration: duration || (current?.duration ?? 0),
      repeat,
      shuffle,
      error,
      playTrack,
      toggle,
      next,
      prev,
      seekTo,
      seekBy,
      cycleRepeat,
      toggleShuffle,
      stop,
    }),
    [
      queue, current, playing, buffering, position, duration, repeat, shuffle, error,
      playTrack, toggle, next, prev, seekTo, seekBy, cycleRepeat, toggleShuffle, stop,
    ]
  );

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): PlayerValue {
  const value = useContext(PlayerContext);
  if (!value) throw new Error('usePlayer вне PlayerProvider');
  return value;
}
