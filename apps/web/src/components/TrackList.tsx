import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Track } from '@vision/shared';
import { formatDuration } from '@vision/shared';
import { api, IS_LOCAL_MODE } from '../api';
import { ensureMedia, getDownloadUrl } from '../media';
import {
  cacheTrack, formatBytes, isOfflineCached, offlineSupported, removeOffline, useOffline,
} from '../offline';
import { announceReplica, sourceLabel, withdrawReplica } from '../seeds';
import { SourcesModal } from './SourcesModal';
import { useLibrary } from '../state/library';
import { usePlayer } from '../state/player';
import { Cover, Icon, useToast } from '../ui';

type Props = {
  tracks: Track[];
  onPlay: (track: Track) => void;
  onRemove?: (track: Track) => void;
  emptyTitle: string;
  emptyHint: string;
  emptyAction?: { label: string; onClick: () => void };
  showArtist?: boolean;
};

/** Списки длиннее этого рисуем окном — 5 000 строк не должны жить в DOM сразу. */
const VIRTUALIZE_AFTER = 120;
const OVERSCAN = 8;

export function TrackList({ tracks, onPlay, onRemove, emptyTitle, emptyHint, emptyAction, showArtist = true }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState(62);
  const [range, setRange] = useState({ start: 0, end: tracks.length });
  const windowed = tracks.length > VIRTUALIZE_AFTER;

  /* реальная высота строки зависит от брейкпоинта — измеряем, а не угадываем */
  useLayoutEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('.track');
    if (!row) return;
    const height = row.getBoundingClientRect().height;
    if (height > 1 && Math.abs(height - rowHeight) > 0.5) setRowHeight(height);
  }, [rowHeight, tracks.length, showArtist]);

  useEffect(() => {
    if (!windowed) {
      setRange((prev) => (prev.start === 0 && prev.end === tracks.length ? prev : { start: 0, end: tracks.length }));
      return;
    }

    const compute = () => {
      const list = listRef.current;
      if (!list) return;
      const rect = list.getBoundingClientRect();
      const viewport = window.innerHeight;
      const offset = Math.max(0, -rect.top);
      const start = Math.max(0, Math.floor(offset / rowHeight) - OVERSCAN);
      const visible = Math.ceil(viewport / rowHeight) + OVERSCAN * 2;
      const end = Math.min(tracks.length, start + visible);
      setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };

    compute();
    window.addEventListener('scroll', compute, { passive: true });
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute);
      window.removeEventListener('resize', compute);
    };
  }, [windowed, rowHeight, tracks.length]);

  if (!tracks.length) {
    return (
      <div className="empty">
        <div className="empty__icon">
          <Icon name="music" size={34} />
        </div>
        <h3>{emptyTitle}</h3>
        <p>{emptyHint}</p>
        {emptyAction && (
          <button type="button" className="btn btn--primary" onClick={emptyAction.onClick}>
            {emptyAction.label}
          </button>
        )}
      </div>
    );
  }

  // список мог сократиться (поиск/удаление) — окно не должно вылезти за границы
  const maxStart = Math.max(0, tracks.length - 1);
  const start = windowed ? Math.min(range.start, maxStart) : 0;
  const end = windowed ? Math.max(Math.min(range.end, tracks.length), start) : tracks.length;

  return (
    <div ref={listRef} className="tracklist" role="list">
      {windowed && start > 0 && (
        <div aria-hidden="true" style={{ height: Math.round(start * rowHeight), flex: '0 0 auto' }} />
      )}
      {tracks.slice(start, end).map((track, offset) => {
        const position = start + offset;
        return (
          <TrackRow
            key={track.id}
            track={track}
            position={position}
            onPlay={() => onPlay(track)}
            onRemove={onRemove ? () => onRemove(track) : undefined}
            showArtist={showArtist}
            total={tracks.length}
          />
        );
      })}
      {windowed && end < tracks.length && (
        <div
          aria-hidden="true"
          style={{ height: Math.round((tracks.length - end) * rowHeight), flex: '0 0 auto' }}
        />
      )}
    </div>
  );
}

function TrackRow({
  track,
  position,
  onPlay,
  onRemove,
  showArtist,
  total,
}: {
  track: Track;
  position: number;
  onPlay: () => void;
  onRemove?: () => void;
  showArtist: boolean;
  total: number;
}) {
  const { playlists, patchTrack, dropTrack, reload } = useLibrary();
  const { current, playing, removeFromQueue, replaceTrack } = usePlayer();
  const { push } = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [newPlaylist, setNewPlaylist] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useOffline(); // подписка: перерисоваться, когда копия появится или исчезнет
  const cached = isOfflineCached(track.id);

  // Трекер говорит, есть ли у кого файл. Офлайн-копия важнее: она уже локально.
  const label = sourceLabel(track);
  const unavailable = !cached && track.available === false;
  const devices = track.sources?.devices ?? 0;

  const isCurrent = current?.id === track.id;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const toggleLike = async (event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      const updated = await api.setLiked(track.id, !track.liked);
      patchTrack(track.id, { liked: updated.liked });
      replaceTrack(updated);
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось обновить лайк', 'error');
    }
  };

  const addToPlaylist = async (playlistId: string) => {
    try {
      await api.addToPlaylist(playlistId, track.id);
      await reload();
      push('Трек добавлен в плейлист');
      setMenuOpen(false);
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось добавить', 'error');
    }
  };

  const createPlaylist = async () => {
    const name = newPlaylist.trim();
    if (!name) return;
    try {
      const playlist = await api.createPlaylist(name);
      await api.addToPlaylist(playlist.id, track.id);
      await reload();
      setNewPlaylist('');
      setMenuOpen(false);
      push(`Плейлист «${name}» создан`);
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось создать плейлист', 'error');
    }
  };

  const downloadOffline = async () => {
    if (downloading) return;
    setDownloading(true);
    setProgress(null);
    try {
      await ensureMedia([track.id]);
      const url = getDownloadUrl(track.id);
      if (!url) throw new Error('Ссылка на файл ещё не готова — попробуйте через секунду');
      const entry = await cacheTrack(track, url, { onProgress: (ratio) => setProgress(ratio) });
      void announceReplica(track); // «у меня есть копия» — в реестр реплик
      push(`Офлайн-копия готова: ${formatBytes(entry.bytes)}`);
      setMenuOpen(false);
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось сохранить копию', 'error');
    } finally {
      setDownloading(false);
      setProgress(null);
    }
  };

  const dropOffline = async () => {
    try {
      await removeOffline(track.id);
      void withdrawReplica(track);
      push('Офлайн-копия удалена');
      setMenuOpen(false);
    } catch {
      push('Не удалось удалить копию', 'error');
    }
  };

  const remove = async () => {
    setMenuOpen(false);
    if (onRemove) {
      onRemove();
      return;
    }
    if (!window.confirm(`Удалить «${track.title}» из библиотеки? Файл будет стёрт с сервера.`)) return;
    try {
      await api.deleteTrack(track.id);
      dropTrack(track.id);
      removeFromQueue(track.id);
      await reload();
      push('Трек удалён');
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось удалить трек', 'error');
    }
  };

  return (
    <div
      className={`track${isCurrent ? ' track--current' : ''}${unavailable ? ' track--unavailable' : ''}`}
      role="listitem"
      aria-posinset={position + 1}
      aria-setsize={total}
      onClick={onPlay}
    >
      <button
        type="button"
        className="track__play"
        aria-label={isCurrent && playing ? 'Пауза' : `Играть ${track.title}`}
        onClick={(event) => {
          event.stopPropagation();
          if (unavailable) {
            push('Ни одно устройство сейчас не раздаёт этот файл', 'error');
            return;
          }
          onPlay();
        }}
      >
        {isCurrent && playing ? (
          <span className="equalizer" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        ) : (
          <>
            <span className="track__index">{position + 1}</span>
            <Icon name="play" size={16} className="track__playicon" />
          </>
        )}
      </button>

      <Cover track={track} size={44} />

      <div className="track__info">
        <span className="track__title">{track.title}</span>
        {showArtist && <span className="track__artist">{track.artist}</span>}
      </div>

      {track.genre && <span className="pill track__genre">{track.genre}</span>}

      {label && (
        <span
          className={`pill track__source${unavailable ? ' track__source--missing' : ''}`}
          title={
            unavailable
              ? 'Ни одно устройство сейчас не раздаёт этот файл'
              : `Копия есть у ${devices} устройств(а), раздавать по HTTP они не умеют`
          }
        >
          {label}
        </span>
      )}

      {!label && devices > 1 && (
        <span className="track__seeds" title={`Файл раздают устройства: ${devices}`}>
          <Icon name="disc" size={12} />
          {devices}
        </span>
      )}

      <span className="track__plays" title="Прослушивания">
        <Icon name="play" size={11} />
        {track.plays}
      </span>

      {cached && (
        <span className="track__offline" title="Есть офлайн-копия">
          <Icon name="download" size={12} />
        </span>
      )}

      <span className="track__time">{formatDuration(track.duration)}</span>

      <button
        type="button"
        className={`iconbtn track__like${track.liked ? ' is-active' : ''}`}
        aria-label={track.liked ? 'Убрать лайк' : 'Поставить лайк'}
        aria-pressed={track.liked}
        onClick={toggleLike}
      >
        <Icon name="heart" size={17} />
      </button>

      <div className="track__menuWrap" ref={menuRef}>
        <button
          type="button"
          className="iconbtn"
          aria-label="Действия с треком"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((v) => !v);
          }}
        >
          <Icon name="more" size={18} />
        </button>

        {menuOpen && (
          <div className="menu" role="menu">
            <div className="menu__label">В плейлист</div>
            <div className="menu__scroll">
              {playlists.length === 0 && <div className="menu__empty">Плейлистов пока нет</div>}
              {playlists.map((playlist) => (
                <button
                  key={playlist.id}
                  type="button"
                  role="menuitem"
                  className="menu__item"
                  onClick={(event) => {
                    event.stopPropagation();
                    void addToPlaylist(playlist.id);
                  }}
                >
                  <Icon name="disc" size={15} />
                  <span>{playlist.name}</span>
                  <span className="menu__count">{playlist.trackCount}</span>
                </button>
              ))}
            </div>
            <div className="menu__create">
              <input
                value={newPlaylist}
                onChange={(event) => setNewPlaylist(event.target.value)}
                placeholder="Новый плейлист"
                aria-label="Название нового плейлиста"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') void createPlaylist();
                }}
              />
              <button
                type="button"
                className="iconbtn"
                aria-label="Создать плейлист"
                onClick={(event) => {
                  event.stopPropagation();
                  void createPlaylist();
                }}
              >
                <Icon name="plus" size={16} />
              </button>
            </div>
            {!IS_LOCAL_MODE && track.checksum && (
              <button
                type="button"
                role="menuitem"
                className="menu__item"
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpen(false);
                  setSourcesOpen(true);
                }}
              >
                <Icon name="disc" size={15} />
                <span>Источники файла</span>
                {devices > 0 && <span className="menu__count">{devices}</span>}
              </button>
            )}
            {offlineSupported() && (
              cached ? (
                <button
                  type="button"
                  role="menuitem"
                  className="menu__item"
                  onClick={(event) => {
                    event.stopPropagation();
                    void dropOffline();
                  }}
                >
                  <Icon name="check" size={15} />
                  <span>Удалить офлайн-копию</span>
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="menu__item"
                  disabled={downloading}
                  onClick={(event) => {
                    event.stopPropagation();
                    void downloadOffline();
                  }}
                >
                  <Icon name="download" size={15} />
                  <span>
                    {downloading
                      ? progress === null
                        ? 'Скачиваю…'
                        : `Скачиваю… ${Math.round(progress * 100)}%`
                      : 'Скачать офлайн'}
                  </span>
                </button>
              )
            )}
            <button type="button" role="menuitem" className="menu__item menu__item--danger" onClick={remove}>
              <Icon name="trash" size={15} />
              <span>{onRemove ? 'Убрать из плейлиста' : 'Удалить трек'}</span>
            </button>
          </div>
        )}
      </div>

      {sourcesOpen && (
        <SourcesModal
          track={track}
          onClose={() => setSourcesOpen(false)}
          onChanged={() => void reload()}
        />
      )}
    </div>
  );
}
