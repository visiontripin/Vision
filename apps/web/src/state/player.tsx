import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import type { Track } from '@vision/shared';
import { api } from '../api';
import { ensureMedia, getMedia, invalidateMedia } from '../media';
import { useLibrary } from './library';

export type RepeatMode = 'off' | 'all' | 'one';

const SAVED_KEY = 'vision.player';

type SavedState = {
  id: string | null;
  position: number;
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  muted: boolean;
};

type PlayerValue = {
  queue: Track[];
  index: number;
  current: Track | null;
  playing: boolean;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  queueOpen: boolean;
  play: (track: Track, list?: Track[]) => void;
  /** Воспроизведение с сохранённой позиции — для «Продолжить слушать». */
  playAt: (track: Track, list: Track[] | undefined, position: number) => void;
  playQueue: (list: Track[], startIndex?: number) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  seekFraction: (fraction: number) => void;
  setVolume: (value: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setQueueOpen: (open: boolean) => void;
  removeFromQueue: (id: string) => void;
  replaceTrack: (track: Track) => void;
};

const PlayerContext = createContext<PlayerValue | null>(null);

function readSaved(): SavedState | null {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedState>;
    return {
      id: typeof parsed.id === 'string' ? parsed.id : null,
      position: Number(parsed.position) || 0,
      volume: typeof parsed.volume === 'number' ? Math.min(1, Math.max(0, parsed.volume)) : 0.9,
      shuffle: Boolean(parsed.shuffle),
      repeat: parsed.repeat === 'one' || parsed.repeat === 'all' ? parsed.repeat : 'off',
      muted: Boolean(parsed.muted),
    };
  } catch {
    return null;
  }
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const { tracks, patchTrack } = useLibrary();

  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(0.9);
  const [muted, setMuted] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>('off');
  const [queueOpen, setQueueOpen] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playingRef = useRef(playing);
  const pendingSeek = useRef(0);
  const counted = useRef(new Set<string>());
  const restored = useRef(false);
  const lastPersist = useRef(0);
  const endedRef = useRef<() => void>(() => {});
  const retried = useRef(new Set<string>());

  const current = queue[index] ?? null;
  const currentId = current?.id ?? null;

  playingRef.current = playing;

  /* ---- единственный аудио-элемент на приложение ---- */
  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.volume = 0.9;
    audioRef.current = audio;

    const onTime = () => setPosition(audio.currentTime);
    const onDuration = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
    };
    const onLoaded = () => {
      if (pendingSeek.current > 0) {
        try {
          audio.currentTime = pendingSeek.current;
        } catch {
          /* метаданные ещё не готовы */
        }
        pendingSeek.current = 0;
      }
      onDuration();
    };
    const onEnded = () => endedRef.current();
    const onError = () => {
      // подпись могла истечь (вкладка спала) — переподписываем один раз
      const id = audio.dataset.trackId;
      if (!id || retried.current.has(id)) return;
      retried.current.add(id);
      invalidateMedia(id);
      void ensureMedia([id]).then(() => {
        const fresh = getMedia(id)?.stream;
        if (!fresh) return;
        const at = audio.currentTime;
        audio.src = fresh;
        audio.load();
        if (at > 0) {
          try {
            audio.currentTime = at;
          } catch {
            /* noop */
          }
        }
        if (playingRef.current) audio.play().catch(() => setPlaying(false));
      });
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('durationchange', onDuration);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);

    return () => {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('durationchange', onDuration);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audioRef.current = null;
    };
  }, []);

  /* ---- смена трека ---- */
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentId) return;
    if (audio.dataset.trackId === currentId) return;

    let cancelled = false;
    const attach = async () => {
      // ссылки подписанные и короткоживущие — берём свежую перед загрузкой
      await ensureMedia([currentId]);
      if (cancelled) return;
      const url = getMedia(currentId)?.stream;
      if (!url) {
        setPlaying(false);
        return;
      }
      retried.current.delete(currentId);
      audio.dataset.trackId = currentId;
      audio.src = url;
      audio.load();
      setPosition(0);
      setDuration(current?.duration ?? 0);
      if (playingRef.current) audio.play().catch(() => setPlaying(false));
    };

    void attach();

    if (!counted.current.has(currentId)) {
      counted.current.add(currentId);
      api
        .registerPlay(currentId)
        .then(() => patchTrack(currentId, { plays: (current?.plays ?? 0) + 1 }))
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  /* ---- прогрев следующего трека (первые 256 КБ в HTTP-кэш) ---- */
  useEffect(() => {
    if (!currentId || !playing || !queue.length) return;
    const next = queue[(index + 1) % queue.length];
    if (!next || next.id === currentId) return;

    let cancelled = false;
    void ensureMedia([next.id]).then(() => {
      if (cancelled) return;
      const url = getMedia(next.id)?.stream;
      if (!url) return;
      void fetch(url, { headers: { Range: 'bytes=0-262143' } }).catch(() => {});
    });

    return () => {
      cancelled = true;
    };
  }, [currentId, playing, queue, index]);

  /* ---- прогресс прослушивания (питает «Продолжить слушать») ---- */
  useEffect(() => {
    if (!currentId || !playing) return;
    let alive = true;

    const report = (completed = false) => {
      if (!alive) return;
      const audio = audioRef.current;
      const pos = audio?.currentTime ?? 0;
      if (pos < 2) return;
      const total = Number.isFinite(audio?.duration) ? (audio?.duration ?? 0) : duration;
      api.listen(currentId, { position: pos, duration: total, completed }).catch(() => {});
    };

    const timer = window.setInterval(() => report(), 10000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      report(position > 0 && duration > 0 && position / duration > 0.9);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, playing]);

  /* ---- play / pause ---- */
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentId) return;
    if (playing) {
      audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  }, [playing, currentId]);

  /* ---- громкость ---- */
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.volume = muted ? 0 : volume;
  }, [volume, muted]);

  /* ---- восстановление сессии ---- */
  useEffect(() => {
    if (restored.current || !audioRef.current || tracks.length === 0) return;
    restored.current = true;
    const saved = readSaved();
    if (!saved) {
      setQueue(tracks);
      return;
    }
    setVolumeState(saved.volume);
    setShuffle(saved.shuffle);
    setRepeat(saved.repeat);
    setMuted(saved.muted);

    const startIndex = saved.id ? tracks.findIndex((t) => t.id === saved.id) : -1;
    setQueue(tracks);
    if (startIndex >= 0) {
      pendingSeek.current = saved.position;
      setIndex(startIndex);
    }
  }, [tracks]);

  /* ---- сохранение сессии ---- */
  useEffect(() => {
    const now = Date.now();
    if (now - lastPersist.current < 1500 && playing) return;
    lastPersist.current = now;
    const payload: SavedState = {
      id: currentId,
      position,
      volume,
      shuffle,
      repeat,
      muted,
    };
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(payload));
    } catch {
      /* приватный режим */
    }
  }, [currentId, position, volume, shuffle, repeat, muted, playing]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const max = Number.isFinite(audio.duration) ? audio.duration : duration;
    const value = Math.max(0, Math.min(max || 0, seconds));
    try {
      audio.currentTime = value;
    } catch {
      /* noop */
    }
    setPosition(value);
  }, [duration]);

  const seekFraction = useCallback(
    (fraction: number) => {
      const total = duration || current?.duration || 0;
      if (total > 0) seek(fraction * total);
    },
    [duration, current?.duration, seek]
  );

  const play = useCallback(
    (track: Track, list?: Track[]) => {
      if (list && list.length) {
        setQueue(list);
        setIndex(Math.max(0, list.findIndex((t) => t.id === track.id)));
      } else {
        const existing = queue.findIndex((t) => t.id === track.id);
        if (existing >= 0) {
          setIndex(existing);
        } else {
          setQueue([...queue, track]);
          setIndex(queue.length);
        }
      }
      setQueueOpen(false);
      setPlaying(true);
    },
    [queue]
  );

  const playAt = useCallback(
    (track: Track, list: Track[] | undefined, position: number) => {
      pendingSeek.current = Math.max(0, position);
      if (list && list.length) {
        setQueue(list);
        setIndex(Math.max(0, list.findIndex((t) => t.id === track.id)));
      } else {
        setQueue((prev) => (prev.some((t) => t.id === track.id) ? prev : [...prev, track]));
      }
      setQueueOpen(false);
      setPlaying(true);
    },
    []
  );

  const playQueue = useCallback((list: Track[], startIndex = 0) => {
    if (!list.length) return;
    setQueue(list);
    setIndex(Math.min(Math.max(0, startIndex), list.length - 1));
    setPlaying(true);
  }, []);

  const toggle = useCallback(() => {
    if (!currentId) {
      if (tracks.length) playQueue(tracks, 0);
      return;
    }
    setPlaying((p) => !p);
  }, [currentId, tracks, playQueue]);

  const next = useCallback(
    (auto = false) => {
      if (!queue.length) return;
      if (auto && repeat === 'one') {
        seek(0);
        return;
      }
      let target: number;
      if (shuffle && queue.length > 1) {
        do {
          target = Math.floor(Math.random() * queue.length);
        } while (target === index);
      } else {
        target = index + 1;
        if (target >= queue.length) {
          if (auto && repeat !== 'all') {
            setPlaying(false);
            seek(0);
            return;
          }
          target = 0;
        }
      }
      setIndex(target);
      setPlaying(true);
    },
    [queue, index, repeat, shuffle, seek]
  );

  const prev = useCallback(() => {
    if (!queue.length) return;
    if (position > 3) {
      seek(0);
      return;
    }
    setIndex((i) => (i - 1 + queue.length) % queue.length);
    setPlaying(true);
  }, [queue.length, position, seek]);

  endedRef.current = () => next(true);

  /* ---- клавиатура ---- */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.code === 'Space') {
        event.preventDefault();
        toggle();
      } else if (event.key === 'ArrowRight' && event.shiftKey) {
        next();
      } else if (event.key === 'ArrowLeft' && event.shiftKey) {
        prev();
      } else if (event.key === 'ArrowRight') {
        seek((audioRef.current?.currentTime ?? 0) + 5);
      } else if (event.key === 'ArrowLeft') {
        seek((audioRef.current?.currentTime ?? 0) - 5);
      } else if (event.key.toLowerCase() === 'm') {
        setMuted((m) => !m);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, next, prev, seek]);

  /* ---- системные медиа-контролы ---- */
  useEffect(() => {
    if (!('mediaSession' in navigator) || !current) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: current.title,
        artist: current.artist,
        album: current.album ?? '',
      });
      navigator.mediaSession.setActionHandler('play', () => setPlaying(true));
      navigator.mediaSession.setActionHandler('pause', () => setPlaying(false));
      navigator.mediaSession.setActionHandler('nexttrack', () => next());
      navigator.mediaSession.setActionHandler('previoustrack', () => prev());
    } catch {
      /* частичная поддержка */
    }
  }, [current, next, prev]);

  const setVolume = useCallback((value: number) => {
    setVolumeState(Math.max(0, Math.min(1, value)));
    setMuted(false);
  }, []);

  const toggleMute = useCallback(() => setMuted((m) => !m), []);
  const toggleShuffle = useCallback(() => setShuffle((s) => !s), []);
  const cycleRepeat = useCallback(
    () => setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off')),
    []
  );

  const removeFromQueue = useCallback(
    (id: string) => {
      setQueue((prev) => {
        const removeIndex = prev.findIndex((t) => t.id === id);
        if (removeIndex < 0) return prev;
        const nextQueue = prev.filter((t) => t.id !== id);
        if (removeIndex < index) setIndex((i) => Math.max(0, i - 1));
        else if (removeIndex === index) {
          setIndex((i) => Math.min(i, Math.max(0, nextQueue.length - 1)));
          if (!nextQueue.length) setPlaying(false);
        }
        return nextQueue;
      });
    },
    [index]
  );

  const replaceTrack = useCallback((track: Track) => {
    setQueue((prev) => prev.map((t) => (t.id === track.id ? track : t)));
  }, []);

  const value = useMemo<PlayerValue>(
    () => ({
      queue, index, current, playing, position, duration, volume, muted, shuffle, repeat, queueOpen,
      play, playAt, playQueue, toggle, next: () => next(false), prev, seek, seekFraction, setVolume, toggleMute,
      toggleShuffle, cycleRepeat, setQueueOpen, removeFromQueue, replaceTrack,
    }),
    [queue, index, current, playing, position, duration, volume, muted, shuffle, repeat, queueOpen,
      play, playAt, playQueue, toggle, next, prev, seek, seekFraction, setVolume, toggleMute, toggleShuffle,
      cycleRepeat, removeFromQueue, replaceTrack]
  );

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): PlayerValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used inside PlayerProvider');
  return ctx;
}
