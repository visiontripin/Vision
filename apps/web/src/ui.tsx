import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { pseudoPeaks, type Track } from '@vision/shared';
import { useMedia } from './media';

/* --------------------------------- иконки --------------------------------- */

const ICONS: Record<string, ReactNode> = {
  play: <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="7" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.4" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  prev: (
    <>
      <path d="M18 6v12L8.5 12z" fill="currentColor" stroke="none" />
      <rect x="5" y="6" width="2.2" height="12" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  next: (
    <>
      <path d="M6 6v12l9.5-6z" fill="currentColor" stroke="none" />
      <rect x="16.8" y="6" width="2.2" height="12" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  shuffle: (
    <>
      <path d="M16 4h4v4" />
      <path d="M20 4l-6.5 6.5" />
      <path d="M4 20l5-5" />
      <path d="M16 20h4v-4" />
      <path d="M20 20l-6.5-6.5" />
      <path d="M4 4l5 5" />
    </>
  ),
  repeat: (
    <>
      <path d="M4 10V8a3 3 0 013-3h10" />
      <path d="M14 2l3 3-3 3" />
      <path d="M20 14v2a3 3 0 01-3 3H7" />
      <path d="M10 22l-3-3 3-3" />
    </>
  ),
  repeatOne: (
    <>
      <path d="M4 10V8a3 3 0 013-3h10" />
      <path d="M14 2l3 3-3 3" />
      <path d="M20 14v2a3 3 0 01-3 3H7" />
      <path d="M10 22l-3-3 3-3" />
      <path d="M12 10.5l1.4-1v4.4" />
    </>
  ),
  heart: <path d="M12 20s-7.5-4.7-7.5-9.5A4.2 4.2 0 0112 8a4.2 4.2 0 017.5 2.5C19.5 15.3 12 20 12 20z" />,
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4" />
      <path d="M7.5 8.5L12 4l4.5 4.5" />
      <path d="M4 16v2.5A2.5 2.5 0 006.5 21h11a2.5 2.5 0 002.5-2.5V16" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5h6v2" />
      <path d="M6 7l1 13h10l1-13" />
    </>
  ),
  volume: (
    <>
      <path d="M4 10v4h3l4 3.5V6.5L7 10z" />
      <path d="M15.5 9a4 4 0 010 6" />
      <path d="M18 6.5a7.5 7.5 0 010 11" />
    </>
  ),
  mute: (
    <>
      <path d="M4 10v4h3l4 3.5V6.5L7 10z" />
      <path d="M16 10l4 4" />
      <path d="M20 10l-4 4" />
    </>
  ),
  queue: (
    <>
      <path d="M4 7h11" />
      <path d="M4 12h11" />
      <path d="M4 17h7" />
      <path d="M19 12v7l-3-1.6" />
    </>
  ),
  close: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </>
  ),
  music: (
    <>
      <path d="M9 18V6l10-2v12" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="16" r="2.5" />
    </>
  ),
  home: (
    <>
      <path d="M4 11l8-6.5 8 6.5" />
      <path d="M6.5 10v9h11v-9" />
    </>
  ),
  disc: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  stats: (
    <>
      <path d="M5 19V9" />
      <path d="M12 19V5" />
      <path d="M19 19v-6" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-8.5 8.5" />
      <path d="M18 14v4.5A1.5 1.5 0 0116.5 20h-11A1.5 1.5 0 014 18.5v-11A1.5 1.5 0 015.5 6H10" />
    </>
  ),
  more: (
    <>
      <circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  logo: (
    <>
      <path d="M5 15V9l4 3-4 3z" fill="currentColor" stroke="none" />
      <path d="M11 18V6l7 6-7 6z" fill="currentColor" stroke="none" />
    </>
  ),
};

export function Icon({ name, size = 20, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name] ?? null}
    </svg>
  );
}

/* --------------------------------- тосты ---------------------------------- */

type Toast = { id: number; text: string; tone: 'ok' | 'error' | 'info' };
type ToastValue = { push: (text: string, tone?: Toast['tone']) => void };
const ToastContext = createContext<ToastValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const counter = useRef(0);

  const push = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = (counter.current += 1);
    setItems((prev) => [...prev.slice(-2), { id, text, tone }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4200);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone}`}>
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

/* ------------------------------- обложка ---------------------------------- */

export function hashHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

export function Cover({ track, size = 48 }: { track: Pick<Track, 'id' | 'title' | 'cover'>; size?: number }) {
  const [failed, setFailed] = useState(false);
  const media = useMedia(track.cover ? track.id : null);
  const hue = hashHue(track.title + track.id);
  const style = {
    width: size,
    height: size,
    background: `linear-gradient(135deg, hsl(${hue} 70% 32%), hsl(${(hue + 55) % 360} 65% 18%))`,
    fontSize: Math.max(12, size * 0.34),
  };

  if (track.cover && media?.cover && !failed) {
    return (
      <img
        className="cover"
        style={{ width: size, height: size }}
        src={media.cover}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div className="cover cover--fallback" style={style} aria-hidden="true">
      {track.title.slice(0, 1).toUpperCase()}
    </div>
  );
}

/* --------------------------- волна (canvas) ------------------------------- */

export function Waveform({
  peaks,
  progress,
  onSeek,
  height = 42,
  compact = false,
  seekable = true,
}: {
  peaks: number[] | null;
  progress: number;
  onSeek?: (fraction: number) => void;
  height?: number;
  compact?: boolean;
  seekable?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  const dragging = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const bars = compact ? Math.max(24, Math.floor(width / 5)) : Math.max(30, Math.floor(width / 4));
    const values = peaks?.length ? peaks : pseudoPeaks('vision', bars);
    const gap = compact ? 2 : 2;
    const barWidth = Math.max(1, (width - gap * (bars - 1)) / bars);
    const played = Math.max(0, Math.min(1, progress));

    // Пиков (320) больше, чем баров: берём среднее по окну и слегка сглаживаем
    // соседние бары — иначе волна «дребезжит» на тихих участках.
    const span = values.length / bars;
    const sampled = Array.from({ length: bars }, (_, i) => {
      const start = Math.floor(i * span);
      const end = Math.max(start + 1, Math.floor((i + 1) * span));
      let sum = 0;
      let count = 0;
      for (let j = start; j < end && j < values.length; j += 1) {
        sum += values[j] ?? 0;
        count += 1;
      }
      return count ? sum / count : 0.2;
    });
    const smoothed = sampled.map((value, i) => {
      const prev = sampled[i - 1] ?? value;
      const next = sampled[i + 1] ?? value;
      return Math.max(0.04, (prev + value * 2 + next) / 4);
    });

    for (let i = 0; i < bars; i += 1) {
      const value = smoothed[i] ?? 0.2;
      const h = Math.max(2, value * (height - (compact ? 6 : 8)));
      const x = i * (barWidth + gap);
      const y = (height - h) / 2;
      const isPlayed = i / bars <= played;
      ctx.fillStyle = isPlayed ? '#ff5a1f' : 'rgba(255,255,255,0.17)';
      ctx.beginPath();
      const r = Math.min(barWidth / 2, 2);
      ctx.roundRect(x, y, barWidth, h, r);
      ctx.fill();
    }
  }, [peaks, progress, width, height, compact]);

  const seekFromEvent = (clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !onSeek) return;
    const rect = canvas.getBoundingClientRect();
    onSeek(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  };

  return (
    <canvas
      ref={canvasRef}
      className={`waveform${seekable ? ' waveform--seekable' : ''}`}
      style={{ height }}
      role={seekable ? 'slider' : 'img'}
      aria-label={seekable ? 'Позиция воспроизведения' : 'Форма волны'}
      aria-valuemin={seekable ? 0 : undefined}
      aria-valuemax={seekable ? 100 : undefined}
      aria-valuenow={seekable ? Math.round(progress * 100) : undefined}
      tabIndex={seekable ? 0 : -1}
      onPointerDown={(event) => {
        if (!seekable) return;
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        seekFromEvent(event.clientX);
      }}
      onPointerMove={(event) => {
        if (dragging.current) seekFromEvent(event.clientX);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onKeyDown={(event) => {
        if (!seekable || !onSeek) return;
        if (event.key === 'ArrowLeft') onSeek(Math.max(0, progress - 0.02));
        if (event.key === 'ArrowRight') onSeek(Math.min(1, progress + 0.02));
      }}
    />
  );
}
