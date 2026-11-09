import { useCallback, useEffect, useRef, useState } from 'react';
import { formatBytes, formatDuration } from '@vision/shared';
import { api } from '../api';
import { useLibrary } from '../state/library';
import { Icon, useToast } from '../ui';

type Status = 'decoding' | 'ready' | 'uploading' | 'done' | 'error';

type Item = {
  key: string;
  file: File;
  title: string;
  artist: string;
  duration: number;
  peaks: number[] | null;
  status: Status;
  progress: number;
  error?: string;
};

const AUDIO_RE = /\.(mp3|wav|flac|ogg|oga|m4a|aac|webm|aiff|aif)$/i;

function parseName(filename: string): { title: string; artist: string } {
  const base = filename.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ').trim();
  const parts = base.split(/\s+-\s+/);
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return { title: base || 'Без названия', artist: 'Unknown' };
}

/** Длительность + 180 нормализованных пиков через Web Audio API. */
async function analyze(file: File): Promise<{ duration: number; peaks: number[] | null }> {
  let duration = 0;
  let peaks: number[] | null = null;

  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (file.size < 160 * 1024 * 1024) {
      const context = new Ctor();
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      const channel = buffer.getChannelData(0);
      const count = 180;
      const block = Math.max(1, Math.floor(channel.length / count));
      const raw: number[] = [];
      let max = 0;
      for (let i = 0; i < count; i += 1) {
        const start = i * block;
        const end = Math.min(channel.length, start + block);
        let sum = 0;
        let samples = 0;
        for (let j = start; j < end; j += 8) {
          sum += channel[j] * channel[j];
          samples += 1;
        }
        const rms = Math.sqrt(sum / Math.max(1, samples));
        raw.push(rms);
        if (rms > max) max = rms;
      }
      peaks = max > 0 ? raw.map((value) => Math.max(0.04, Number((value / max).toFixed(3)))) : raw;
      duration = buffer.duration;
      await context.close();
    }
  } catch {
    peaks = null;
  }

  if (!duration) {
    duration = await new Promise<number>((resolve) => {
      const url = URL.createObjectURL(file);
      const audio = new Audio();
      audio.preload = 'metadata';
      const done = (value: number) => {
        URL.revokeObjectURL(url);
        resolve(value);
      };
      audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : 0);
      audio.onerror = () => done(0);
      audio.src = url;
    });
  }

  return { duration, peaks };
}

export function UploadModal({
  open,
  onClose,
  initialFiles,
  onFilesConsumed,
}: {
  open: boolean;
  onClose: () => void;
  initialFiles?: File[] | null;
  onFilesConsumed?: () => void;
}) {
  const { reload } = useLibrary();
  const { push } = useToast();
  const [items, setItems] = useState<Item[]>([]);
  const [genre, setGenre] = useState('');
  const [album, setAlbum] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    if (!open) {
      setItems([]);
      setGenre('');
      setAlbum('');
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, busy, onClose]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).filter((file) => AUDIO_RE.test(file.name) || file.type.startsWith('audio/'));
    if (!list.length) {
      push('Поддерживаются mp3, wav, flac, ogg, m4a', 'error');
      return;
    }

    const prepared: Item[] = list.map((file) => {
      const { title, artist } = parseName(file.name);
      return {
        key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        title,
        artist,
        duration: 0,
        peaks: null,
        status: 'decoding',
        progress: 0,
      };
    });

    setItems((prev) => [...prev, ...prepared]);

    for (const item of prepared) {
      const result = await analyze(item.file);
      setItems((prev) =>
        prev.map((entry) =>
          entry.key === item.key ? { ...entry, ...result, status: 'ready' } : entry
        )
      );
    }
  }, [push]);

  useEffect(() => {
    if (!open || !initialFiles?.length) return;
    void addFiles(initialFiles);
    onFilesConsumed?.();
  }, [open, initialFiles, addFiles, onFilesConsumed]);

  const removeItem = (key: string) => setItems((prev) => prev.filter((item) => item.key !== key));

  const patchItem = (key: string, patch: Partial<Item>) =>
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  const startUpload = async () => {
    const ready = items.filter((item) => item.status === 'ready' || item.status === 'error');
    if (!ready.length) return;
    setBusy(true);
    let uploaded = 0;

    for (const item of ready) {
      patchItem(item.key, { status: 'uploading', progress: 0, error: undefined });
      try {
        await api.uploadTrack(
          item.file,
          {
            title: item.title.trim() || item.title,
            artist: item.artist.trim() || 'Unknown',
            album: album.trim() || undefined,
            genre: genre.trim() || undefined,
            duration: item.duration,
            peaks: item.peaks ?? undefined,
            filename: item.file.name,
          },
          (percent) => patchItem(item.key, { progress: percent })
        );
        patchItem(item.key, { status: 'done', progress: 100 });
        uploaded += 1;
      } catch (error) {
        patchItem(item.key, {
          status: 'error',
          error: error instanceof Error ? error.message : 'Ошибка загрузки',
        });
      }
    }

    setBusy(false);
    await reload();
    if (uploaded) push(uploaded === 1 ? 'Трек загружен' : `Загружено треков: ${uploaded}`);
    if (uploaded === ready.length) setTimeout(onClose, 700);
  };

  if (!open) return null;

  const totalSize = items.reduce((sum, item) => sum + item.file.size, 0);
  const readyCount = items.filter((item) => item.status === 'ready' || item.status === 'error').length;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Загрузка треков">
      <div className="modal__backdrop" onClick={() => !busy && onClose()} />
      <div className="modal__card modal__card--wide">
        <header className="modal__head">
          <div>
            <h2>Загрузить треки</h2>
            <p>mp3, wav, flac, ogg, m4a · до 500 МБ на файл</p>
          </div>
          <button type="button" className="iconbtn" aria-label="Закрыть" onClick={onClose} disabled={busy}>
            <Icon name="close" size={20} />
          </button>
        </header>

        <div
          className={`dropzone${dragging ? ' is-over' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragEnter={(event) => {
            event.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            event.preventDefault();
            dragDepth.current -= 1;
            if (dragDepth.current <= 0) setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            void addFiles(event.dataTransfer.files);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
          }}
        >
          <Icon name="upload" size={26} />
          <strong>Перетащите файлы сюда</strong>
          <span>или нажмите, чтобы выбрать на устройстве</span>
          <input
            ref={inputRef}
            type="file"
            accept="audio/*,.mp3,.wav,.flac,.ogg,.m4a"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) void addFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </div>

        {items.length > 0 && (
          <div className="upload-list">
            {items.map((item) => (
              <div key={item.key} className={`upload-item upload-item--${item.status}`}>
                <div className="upload-item__top">
                  <span className="upload-item__file" title={item.file.name}>
                    {item.file.name}
                  </span>
                  <span className="upload-item__size">
                    {formatBytes(item.file.size)} · {formatDuration(item.duration)}
                  </span>
                  <button
                    type="button"
                    className="iconbtn"
                    aria-label="Убрать файл"
                    disabled={busy || item.status === 'done'}
                    onClick={() => removeItem(item.key)}
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>

                <div className="upload-item__fields">
                  <label>
                    <span>Название</span>
                    <input
                      value={item.title}
                      disabled={busy}
                      onChange={(event) => patchItem(item.key, { title: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>Исполнитель</span>
                    <input
                      value={item.artist}
                      disabled={busy}
                      onChange={(event) => patchItem(item.key, { artist: event.target.value })}
                    />
                  </label>
                </div>

                {item.status === 'decoding' && <div className="upload-item__hint">Анализ аудио и волны…</div>}
                {item.status === 'error' && <div className="upload-item__hint upload-item__hint--error">{item.error}</div>}
                {item.status === 'uploading' && (
                  <div className="progress">
                    <i style={{ width: `${item.progress}%` }} />
                    <span>{item.progress}%</span>
                  </div>
                )}
                {item.status === 'done' && (
                  <div className="upload-item__hint upload-item__hint--ok">
                    <Icon name="check" size={14} /> Готово
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="upload-meta">
          <label>
            <span>Жанр для всех</span>
            <input value={genre} onChange={(event) => setGenre(event.target.value)} placeholder="например, Ambient" />
          </label>
          <label>
            <span>Альбом для всех</span>
            <input value={album} onChange={(event) => setAlbum(event.target.value)} placeholder="необязательно" />
          </label>
        </div>

        <footer className="modal__foot">
          <span className="modal__summary">
            {items.length ? `${items.length} файлов · ${formatBytes(totalSize)}` : 'Файлы ещё не выбраны'}
          </span>
          <div className="modal__actions">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Закрыть
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={startUpload}
              disabled={busy || readyCount === 0}
            >
              {busy ? 'Загружаем…' : `Загрузить${readyCount > 1 ? ` (${readyCount})` : ''}`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
