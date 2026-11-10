import { useCallback, useEffect, useRef, useState } from 'react';
import { formatBytes, formatDuration, VisionError } from '@vision/shared';
import { analyze, isAudioFile, parseName } from '../audio';
import { api } from '../api';
import { filesFromDataTransfer } from '../bulk/drop';
import { extractAudioFromZip, isZipFile } from '../bulk/zip';
import { useLibrary } from '../state/library';
import { Icon, useToast } from '../ui';

type Status = 'decoding' | 'ready' | 'uploading' | 'done' | 'duplicate' | 'error';

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
  const [unpacking, setUnpacking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    if (!open) {
      setItems([]);
      setGenre('');
      setAlbum('');
      setBusy(false);
      setUnpacking(false);
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

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const incoming = Array.from(files);
      const zips = incoming.filter(isZipFile);
      const plain = incoming.filter((file) => !isZipFile(file) && isAudioFile(file));

      const expanded: File[] = [...plain];
      const artistHints: Record<string, string> = {};
      let skipped = 0;

      if (zips.length) {
        setUnpacking(true);
        try {
          for (const zip of zips) {
            try {
              const result = await extractAudioFromZip(zip);
              expanded.push(...result.files);
              Object.assign(artistHints, result.artistHints);
              skipped += result.skipped;
              if (result.truncated) push(`Из ${zip.name} взяли первые 2000 треков`, 'error');
            } catch (error) {
              push(error instanceof Error ? error.message : `Не удалось прочитать ${zip.name}`, 'error');
            }
          }
        } finally {
          setUnpacking(false);
        }
      }

      if (!expanded.length) {
        push('Поддерживаются mp3, wav, flac, ogg, m4a — или .zip с ними', 'error');
        return;
      }
      if (skipped) push(`В архивах пропущено файлов: ${skipped}`);

      const prepared: Item[] = expanded.map((file, index) => {
        const parsed = parseName(file.name);
        const hint = artistHints[file.name];
        const title = parsed.title;
        const artist = parsed.artist === 'Unknown' && hint ? hint : parsed.artist;
        return {
          key: `${file.name}-${file.size}-${index}-${Math.random().toString(36).slice(2, 8)}`,
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
          prev.map((entry) => (entry.key === item.key ? { ...entry, ...result, status: 'ready' } : entry))
        );
      }
    },
    [push]
  );

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
    let duplicates = 0;
    let failed = 0;

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
        if (error instanceof VisionError && error.code === 'duplicate') {
          patchItem(item.key, { status: 'duplicate', error: 'Этот файл уже есть в библиотеке' });
          duplicates += 1;
        } else {
          patchItem(item.key, {
            status: 'error',
            error: error instanceof Error ? error.message : 'Ошибка загрузки',
          });
          failed += 1;
        }
      }
    }

    setBusy(false);
    await reload();

    const parts: string[] = [];
    if (uploaded) parts.push(`загружено ${uploaded}`);
    if (duplicates) parts.push(`дубликатов ${duplicates}`);
    if (failed) parts.push(`ошибок ${failed}`);
    if (parts.length) push(parts.join(' · '));

    if (uploaded && !duplicates && !failed) setTimeout(onClose, 700);
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
            <p>mp3, wav, flac, ogg, m4a · папка целиком или .zip · до 500 МБ на файл</p>
          </div>
          <button type="button" className="iconbtn" aria-label="Закрыть" onClick={onClose} disabled={busy}>
            <Icon name="close" size={20} />
          </button>
        </header>

        <div
          className={`dropzone${dragging ? ' is-over' : ''}`}
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
            const transfer = event.dataTransfer;
            void filesFromDataTransfer(transfer).then((files) => addFiles(files));
          }}
        >
          <Icon name="upload" size={26} />
          <strong>{unpacking ? 'Распаковываем архив…' : 'Перетащите файлы, папку или .zip'}</strong>
          <span>или выберите на устройстве — можно сразу целую папку</span>
          <div className="dropzone__actions">
            <button
              type="button"
              className="btn btn--small"
              onClick={(event) => {
                event.stopPropagation();
                inputRef.current?.click();
              }}
            >
              Выбрать файлы
            </button>
            <button
              type="button"
              className="btn btn--small"
              onClick={(event) => {
                event.stopPropagation();
                folderRef.current?.click();
              }}
            >
              Папка
            </button>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="audio/*,.mp3,.wav,.flac,.ogg,.m4a,.opus,.aiff,.zip"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) void addFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <input
            ref={folderRef}
            type="file"
            multiple
            hidden
            {...({ webkitdirectory: 'true', directory: 'true' } as Record<string, string>)}
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
                {item.status === 'duplicate' && (
                  <div className="upload-item__hint upload-item__hint--warn">
                    <Icon name="check" size={14} /> {item.error ?? 'Уже в библиотеке'}
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
            {items.some((item) => item.status === 'duplicate') &&
              ` · дубликатов ${items.filter((item) => item.status === 'duplicate').length}`}
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
