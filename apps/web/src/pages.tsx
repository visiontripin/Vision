import { useEffect, useMemo, useRef, useState } from 'react';
import {
  formatBytes,
  formatDuration,
  type ExternalTrack,
  type HistoryEntry,
  type Dashboard,
  type PersonalFeed,
  type Playlist,
  type Share,
  type SmartPlaylist,
  type Track,
} from '@vision/shared';
import { api, apiBase, IS_LOCAL_MODE } from './api';
import { clearOffline, formatBytes as formatOfflineBytes, setOfflineLimitMb, useOffline } from './offline';
import { readSnapshot, snapshotAge } from './library-cache';
import { ShareModal } from './components/ShareModal';
import { SmartPlaylistForm } from './components/SmartPlaylistForm';
import { toRules } from './smart-form';
import { TrackList } from './components/TrackList';
import { useLibrary } from './state/library';
import { usePlayer } from './state/player';
import { Cover, Icon, useToast } from './ui';

type LibraryProps = {
  search: string;
  onUpload: () => void;
};

const SORTS = [
  { value: 'recent', label: 'Сначала новые' },
  { value: 'title', label: 'По названию' },
  { value: 'plays', label: 'По прослушиваниям' },
  { value: 'duration', label: 'По длительности' },
] as const;

type SortValue = (typeof SORTS)[number]['value'];

function useFilteredTracks(tracks: Track[], search: string, genre: string | null, sort: SortValue) {
  return useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = tracks.filter((track) => {
      const matchesGenre = !genre || track.genre === genre;
      if (!matchesGenre) return false;
      if (!needle) return true;
      return `${track.title} ${track.artist} ${track.album ?? ''} ${track.genre ?? ''}`
        .toLowerCase()
        .includes(needle);
    });

    const sorted = [...filtered];
    if (sort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    else if (sort === 'plays') sorted.sort((a, b) => b.plays - a.plays);
    else if (sort === 'duration') sorted.sort((a, b) => b.duration - a.duration);
    else sorted.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return sorted;
  }, [tracks, search, genre, sort]);
}

/**
 * Поиск на сервере (FTS5) — используется, когда запрос осмысленный и мы не
 * в локальном режиме. Локальная фильтрация остаётся фолбэком и живёт в
 * IndexedDB-режиме, где сервера нет вовсе.
 */
function useServerSearch(search: string, sort: SortValue) {
  const [result, setResult] = useState<{ items: Track[]; total: number } | null>(null);
  const query = search.trim();

  useEffect(() => {
    if (IS_LOCAL_MODE || query.length < 2) {
      setResult(null);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      api
        .tracksPage({ q: query, sort: sort === 'recent' ? 'recent' : sort, limit: 100 })
        .then((page) => {
          if (alive) setResult(page);
        })
        .catch(() => {
          if (alive) setResult(null);
        });
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query, sort]);

  return result;
}

/**
 * «Для вас» (J3): подборки из собственной истории — без внешних сервисов и без
 * «рекомендаций», которые нечем объяснить. У каждой секции есть причина, и это
 * главное отличие от бесконечной ленты: человек видит, **почему** эти треки.
 *
 * В локальном режиме (IndexedDB на GitHub Pages) подборок нет: серверная история
 * прослушиваний там не ведётся, а притворяться, что мы что-то знаем, нельзя.
 */
export function PersonalPage() {
  const player = usePlayer();
  const [feed, setFeed] = useState<PersonalFeed | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (IS_LOCAL_MODE) return;
    let cancelled = false;
    api
      .personal()
      .then((result) => {
        if (!cancelled) setFeed(result);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Не удалось собрать подборки');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (IS_LOCAL_MODE) {
    return (
      <section className="page">
        <header className="page__head">
          <div>
            <h1>Для вас</h1>
            <p>Подборки по истории прослушиваний</p>
          </div>
        </header>
        <div className="empty">
          <h3>Здесь нужен сервер</h3>
          <p>
            Подборки строятся по истории прослушиваний на сервере. В локальном режиме
            (GitHub Pages) история не ведётся — откройте свою копию Vision Server.
          </p>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="page">
        <div className="empty">
          <h3>Подборки не собрались</h3>
          <p>{error}</p>
        </div>
      </section>
    );
  }

  if (!feed) {
    return (
      <section className="page">
        <div className="skeleton-list">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="skeleton-row" />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1>{feed.greeting}</h1>
          <p>
            {feed.sections.length
              ? `${feed.libraryTracks} треков в библиотеке · подборки обновляются раз в день`
              : 'Пока нечего показать'}
          </p>
        </div>
        <a className="btn btn--ghost btn--sm" href="#/">
          <Icon name="home" size={15} />
          Вся библиотека
        </a>
      </header>

      {!feed.sections.length && (
        <div className="empty">
          <h3>Подборок пока нет</h3>
          <p>{feed.hint ?? 'Послушайте несколько треков — и они появятся.'}</p>
        </div>
      )}

      {feed.sections.map((section) => (
        <div className="personal-section" key={section.key}>
          <div className="personal-section__head">
            <div>
              <h2>{section.title}</h2>
              <p>{section.reason}</p>
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => player.playQueue(section.tracks, 0)}
            >
              <Icon name="play" size={14} />
              Слушать всё
            </button>
          </div>
          <TrackList
            tracks={section.tracks}
            onPlay={(track) => player.play(track, section.tracks)}
            emptyTitle="Пусто"
            emptyHint="Подборка пересчитается после следующих прослушиваний."
          />
        </div>
      ))}
    </section>
  );
}

export function LibraryPage({ search, onUpload }: LibraryProps) {
  const { tracks, stats, loading } = useLibrary();
  const player = usePlayer();
  const [genre, setGenre] = useState<string | null>(null);
  const [sort, setSort] = useState<SortValue>('recent');
  const localFiltered = useFilteredTracks(tracks, search, genre, sort);
  const remote = useServerSearch(search, sort);
  const filtered = remote && !genre ? remote.items : localFiltered;
  const searching = Boolean(remote && !genre);

  const genres = stats?.genres ?? [];

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1>Библиотека</h1>
          <p>
            {searching ? `Найдено: ${remote?.total ?? 0}` : `${tracks.length} треков`} ·{' '}
            {formatDuration(stats?.duration ?? 0)} звучания
          </p>
        </div>
        <div className="page__tools">
          <select
            className="select"
            value={sort}
            onChange={(event) => setSort(event.target.value as SortValue)}
            aria-label="Сортировка"
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn--primary" onClick={onUpload}>
            <Icon name="upload" size={16} />
            Загрузить
          </button>
        </div>
      </header>

      {genres.length > 0 && (
        <div className="chips" role="group" aria-label="Фильтр по жанру">
          <button
            type="button"
            className={`chip${genre === null ? ' is-active' : ''}`}
            onClick={() => setGenre(null)}
          >
            Все жанры
          </button>
          {genres.slice(0, 10).map((item) => (
            <button
              key={item.genre}
              type="button"
              className={`chip${genre === item.genre ? ' is-active' : ''}`}
              onClick={() => setGenre(genre === item.genre ? null : item.genre)}
            >
              {item.genre}
              <span>{item.count}</span>
            </button>
          ))}
        </div>
      )}

      {!search && !genre && <ContinueListening />}

      {loading ? (
        <div className="skeleton-list">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="skeleton-row" />
          ))}
        </div>
      ) : (
        <TrackList
          tracks={filtered}
          onPlay={(track) => player.play(track, filtered)}
          emptyTitle={search ? 'Ничего не найдено' : 'Библиотека пуста'}
          emptyHint={
            search
              ? 'Попробуйте другой запрос или сбросьте фильтр по жанру.'
              : 'Загрузите первый трек — перетащите файл в окно загрузки, волна и плеер появятся сразу.'
          }
          emptyAction={search ? undefined : { label: 'Загрузить трек', onClick: onUpload }}
        />
      )}
    </section>
  );
}

/** Блок «Продолжить слушать»: последние прослушивания с позицией. */
function ContinueListening() {
  const { tracks } = useLibrary();
  const player = usePlayer();
  const [items, setItems] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    if (IS_LOCAL_MODE) return;
    let alive = true;
    api
      .history(12)
      .then((entries) => {
        if (!alive) return;
        setItems(entries.filter((entry) => !entry.completed && entry.position > 3));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [player.current?.id]);

  if (!items.length) return null;

  const list = items
    .map((entry) => tracks.find((track) => track.id === entry.track.id))
    .filter((track): track is Track => Boolean(track));

  return (
    <section className="continue" aria-labelledby="continue-title">
      <div className="continue__head">
        <h2 id="continue-title">Продолжить слушать</h2>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            setItems([]);
            void api.clearHistory().catch(() => {});
          }}
        >
          Очистить
        </button>
      </div>
      <div className="continue__row">
        {items.map((entry) => {
          const track = tracks.find((item) => item.id === entry.track.id);
          if (!track) return null;
          const percent = entry.duration ? Math.min(100, (entry.position / entry.duration) * 100) : 0;
          return (
            <button
              key={entry.track.id}
              type="button"
              className="continue-card"
              onClick={() => player.playAt(track, list, entry.position)}
            >
              <Cover track={track} size={64} />
              <span className="continue-card__body">
                <strong>{track.title}</strong>
                <span className="muted">{track.artist}</span>
                <span className="continue-card__bar" aria-hidden="true">
                  <i style={{ width: `${percent}%` }} />
                </span>
                <span className="continue-card__time">
                  {formatDuration(entry.position)} / {formatDuration(entry.duration || track.duration)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function LikedPage() {
  const { tracks, loading } = useLibrary();
  const player = usePlayer();
  const liked = useMemo(() => tracks.filter((track) => track.liked), [tracks]);

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1>Лайкнутое</h1>
          <p>{liked.length} треков, которые вы отметили</p>
        </div>
      </header>
      {loading ? (
        <div className="skeleton-row" />
      ) : (
        <TrackList
          tracks={liked}
          onPlay={(track) => player.play(track, liked)}
          emptyTitle="Пока ничего не лайкнуто"
          emptyHint="Нажмите на сердечко в списке треков или в плеере — избранное соберётся здесь."
        />
      )}
    </section>
  );
}

export function PlaylistsPage() {
  const { playlists, reload } = useLibrary();
  const { push } = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [smart, setSmart] = useState<SmartPlaylist[] | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Умные плейлисты живут отдельным запросом: их состав считает сервер, и в
  // снимке библиотеки (I5) их нет — офлайн-список правил ничего не даёт.
  useEffect(() => {
    if (IS_LOCAL_MODE) {
      setSmart([]);
      return;
    }
    let cancelled = false;
    api
      .smartPlaylists()
      .then((items) => {
        if (!cancelled) setSmart(items);
      })
      .catch(() => {
        if (!cancelled) setSmart([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const createSmart = async (draft: Parameters<typeof toRules>[0] & { name: string }) => {
    setBusy(true);
    setFormError(null);
    try {
      await api.createSmartPlaylist({ name: draft.name, rules: toRules(draft) });
      setFormOpen(false);
      setSmart(await api.smartPlaylists());
      push('Умный плейлист создан');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Не удалось создать плейлист');
    } finally {
      setBusy(false);
    }
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.createPlaylist(name.trim());
      setName('');
      await reload();
      push('Плейлист создан');
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось создать плейлист', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1>Плейлисты</h1>
          <p>{playlists.length} коллекций</p>
        </div>
        <form className="inline-form" onSubmit={create}>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Название плейлиста"
            aria-label="Название нового плейлиста"
          />
          <button type="submit" className="btn btn--primary" disabled={busy || !name.trim()}>
            <Icon name="plus" size={16} />
            Создать
          </button>
        </form>
      </header>

      {playlists.length === 0 && !smart?.length && !formOpen ? (
        <div className="empty">
          <div className="empty__icon">
            <Icon name="disc" size={34} />
          </div>
          <h3>Плейлистов пока нет</h3>
          <p>Соберите подборки под настроение: введите название выше или добавьте трек через меню «⋯».</p>
        </div>
      ) : (
        <div className="playlist-grid">
          {playlists.map((playlist) => (
            <PlaylistCard key={playlist.id} playlist={playlist} />
          ))}
          {smart?.map((playlist) => (
            <SmartPlaylistCard key={playlist.id} playlist={playlist} />
          ))}
        </div>
      )}

      {!IS_LOCAL_MODE && (
        <div className="panel smart-panel">
          <div className="smart-panel__head">
            <div>
              <h2>Умные плейлисты</h2>
              <p>
                Подборка по правилам: «жанр = Ambient и не слушал 30 дней». Состав пересчитывается
                сам — добавите подходящий трек, и он окажется внутри.
              </p>
            </div>
            {!formOpen && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setFormOpen(true)}>
                <Icon name="plus" size={15} />
                Собрать по правилам
              </button>
            )}
          </div>

          {formOpen && (
            <SmartPlaylistForm
              busy={busy}
              error={formError}
              onSubmit={(draft) => void createSmart(draft)}
              onCancel={() => {
                setFormOpen(false);
                setFormError(null);
              }}
            />
          )}

          {!formOpen && (smart?.length ?? 0) === 0 && (
            <p className="muted smart-panel__hint">
              Пока ни одного. Начните с простого: «Длительность не короче 300 секунд, сначала
              старые» — так находится то, что давно не слушали.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function PlaylistCard({ playlist }: { playlist: Playlist }) {
  const hue = (playlist.name.charCodeAt(0) * 37 + playlist.name.length * 11) % 360;
  return (
    <a className="playlist-card" href={`#/playlists/${playlist.id}`}>
      <div
        className="playlist-card__art"
        style={{ background: `linear-gradient(140deg, hsl(${hue} 72% 40%), hsl(${(hue + 70) % 360} 60% 16%))` }}
      >
        <Icon name="disc" size={30} />
      </div>
      <div className="playlist-card__meta">
        <strong>{playlist.name}</strong>
        <span>
          {playlist.trackCount} треков · {formatDuration(playlist.duration)}
        </span>
      </div>
    </a>
  );
}

function SmartPlaylistCard({ playlist }: { playlist: SmartPlaylist }) {
  const hue = (playlist.name.charCodeAt(0) * 41 + playlist.name.length * 13) % 360;
  return (
    <a className="playlist-card playlist-card--smart" href={`#/smart/${playlist.id}`}>
      <div
        className="playlist-card__art"
        style={{ background: `linear-gradient(140deg, hsl(${hue} 70% 38%), hsl(${(hue + 150) % 360} 55% 14%))` }}
      >
        <Icon name="search" size={28} />
      </div>
      <div className="playlist-card__meta">
        <strong>{playlist.name}</strong>
        <span>{playlist.trackCount} треков · по правилам</span>
        {playlist.summary && <em className="playlist-card__rules">{playlist.summary}</em>}
      </div>
    </a>
  );
}

/**
 * Умный плейлист (C7): тот же список, что у обычного, но состав вычисляет
 * сервер. Правила можно поправить на месте — иначе «умный» превращался бы в
 * «одноразовый мастер».
 */
export function SmartPlaylistPage({ id, search }: { id: string; search: string }) {
  const player = usePlayer();
  const { push } = useToast();
  const [playlist, setPlaylist] = useState<SmartPlaylist | null>(null);
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const load = async () => {
    try {
      const [meta, list] = await Promise.all([api.smartPlaylist(id), api.smartPlaylistTracks(id)]);
      setPlaylist(meta);
      setTracks(list);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : 'Не удалось открыть плейлист');
      setTracks([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const visible = useMemo(() => {
    if (!tracks) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return tracks;
    return tracks.filter((track) =>
      `${track.title} ${track.artist} ${track.genre ?? ''}`.toLowerCase().includes(needle)
    );
  }, [tracks, search]);

  const save = async (draft: Parameters<typeof toRules>[0] & { name: string }) => {
    setBusy(true);
    setFormError(null);
    try {
      const updated = await api.updateSmartPlaylist(id, { name: draft.name, rules: toRules(draft) });
      setPlaylist(updated);
      setTracks(await api.smartPlaylistTracks(id));
      setEditing(false);
      push('Правила обновлены');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Не удалось сохранить правила');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!playlist || !window.confirm(`Удалить «${playlist.name}»? Треки останутся в библиотеке.`)) return;
    try {
      await api.deleteSmartPlaylist(id);
      push('Умный плейлист удалён');
      window.location.hash = '#/playlists';
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось удалить', 'error');
    }
  };

  if (failed) {
    return (
      <section className="page">
        <div className="empty">
          <h3>Плейлист не открылся</h3>
          <p>{failed}</p>
          <a className="btn" href="#/playlists">
            Ко всем плейлистам
          </a>
        </div>
      </section>
    );
  }

  if (!playlist) {
    return (
      <section className="page">
        <div className="skeleton-list">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="skeleton-row" />
          ))}
        </div>
      </section>
    );
  }

  const initialDraft = {
    name: playlist.name,
    match: playlist.rules?.match ?? ('all' as const),
    sort: playlist.rules?.sort ?? ('recent' as const),
    limit: playlist.rules?.limit ?? 40,
    rules: (playlist.rules?.rules ?? []).map((rule) => ({
      field: rule.field,
      op: rule.op,
      value: rule.value === undefined || rule.value === null ? '' : String(rule.value),
    })),
  };

  return (
    <section className="page">
      <header className="page__head page__head--playlist">
        <div>
          <a className="backlink" href="#/playlists">
            ← Плейлисты
          </a>
          <h1>{playlist.name}</h1>
          <p>
            {playlist.trackCount} треков по правилам · {playlist.summary}
          </p>
        </div>
        <div className="page__tools">
          <button
            type="button"
            className="btn btn--primary"
            disabled={!visible.length}
            onClick={() => player.playQueue(visible, 0)}
          >
            <Icon name="play" size={16} />
            Слушать
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => setEditing((prev) => !prev)}>
            <Icon name="settings" size={16} />
            {editing ? 'Свернуть' : 'Правила'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void remove()}>
            <Icon name="trash" size={16} />
            Удалить
          </button>
        </div>
      </header>

      {editing && (
        <SmartPlaylistForm
          title="Правила подборки"
          submitLabel="Сохранить"
          initial={initialDraft}
          busy={busy}
          error={formError}
          onSubmit={(draft) => void save(draft)}
          onCancel={() => setEditing(false)}
        />
      )}

      {tracks === null ? (
        <div className="skeleton-list">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="skeleton-row" />
          ))}
        </div>
      ) : (
        <TrackList
          tracks={visible}
          onPlay={(track) => player.play(track, visible)}
          emptyTitle="Под правила пока ничего не подходит"
          emptyHint="Правила можно ослабить: уберите условие или уменьшите число дней."
        />
      )}
    </section>
  );
}

export function PlaylistPage({ id, search }: { id: string; search: string }) {
  const { playlists, reload } = useLibrary();
  const player = usePlayer();
  const { push } = useToast();
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const playlist = playlists.find((item) => item.id === id);

  useEffect(() => {
    let cancelled = false;
    setTracks(null);
    api
      .playlistTracks(id)
      .then((result) => {
        if (!cancelled) setTracks(result);
      })
      .catch(() => {
        if (!cancelled) setTracks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const visible = useMemo(() => {
    if (!tracks) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return tracks;
    return tracks.filter((track) =>
      `${track.title} ${track.artist} ${track.genre ?? ''}`.toLowerCase().includes(needle)
    );
  }, [tracks, search]);

  const remove = async (track: Track) => {
    try {
      await api.removeFromPlaylist(id, track.id);
      setTracks((prev) => (prev ? prev.filter((item) => item.id !== track.id) : prev));
      await reload();
      push('Трек убран из плейлиста');
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось убрать трек', 'error');
    }
  };

  const removePlaylist = async () => {
    if (!playlist || !window.confirm(`Удалить плейлист «${playlist.name}»? Треки останутся в библиотеке.`)) return;
    try {
      await api.deletePlaylist(id);
      await reload();
      push('Плейлист удалён');
      window.location.hash = '#/playlists';
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось удалить плейлист', 'error');
    }
  };

  if (!playlist) {
    return (
      <section className="page">
        <div className="empty">
          <h3>Плейлист не найден</h3>
          <p>Возможно, он был удалён.</p>
          <a className="btn" href="#/playlists">
            Ко всем плейлистам
          </a>
        </div>
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page__head page__head--playlist">
        <div>
          <a className="backlink" href="#/playlists">
            ← Плейлисты
          </a>
          <h1>{playlist.name}</h1>
          <p>
            {playlist.trackCount} треков · {formatDuration(playlist.duration)}
          </p>
        </div>
        <div className="page__tools">
          <button
            type="button"
            className="btn btn--primary"
            disabled={!visible.length}
            onClick={() => player.playQueue(visible, 0)}
          >
            <Icon name="play" size={16} />
            Слушать
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => setShareOpen(true)}>
            <Icon name="share" size={16} />
            Ссылка
          </button>
          <button type="button" className="btn btn--ghost" onClick={removePlaylist}>
            <Icon name="trash" size={16} />
            Удалить
          </button>
        </div>
      </header>

      {tracks === null ? (
        <div className="skeleton-list">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="skeleton-row" />
          ))}
        </div>
      ) : (
        <TrackList
          tracks={visible}
          onPlay={(track) => player.play(track, visible)}
          onRemove={remove}
          emptyTitle="В плейлисте пусто"
          emptyHint="Откройте библиотеку и добавьте треки через меню «⋯» рядом с треком."
        />
      )}

      {shareOpen && playlist && (
        <ShareModal
          target={{
            kind: 'playlist',
            id: playlist.id,
            name: playlist.name,
            cover: visible[0] ?? null,
          }}
          onClose={() => setShareOpen(false)}
        />
      )}
    </section>
  );
}

/**
 * «Ссылки» — все приватные ссылки владельца в одном месте: что открывали, сколько
 * раз, что истекло. Отзыв и перевыпуск здесь же; сам токен повторно не показывается
 * (в БД только хеш), поэтому скомпрометированную ссылку именно перевыпускают.
 */
export function SharesPage({
  tracksById,
  playlists,
}: {
  tracksById: Map<string, Track>;
  playlists: Playlist[];
}) {
  const { push } = useToast();
  const [shares, setShares] = useState<Share[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showDead, setShowDead] = useState(false);

  const load = async () => {
    try {
      setShares(await api.shares({ includeRevoked: true }));
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось получить ссылки', 'error');
      setShares([]);
    }
  };

  useEffect(() => {
    if (IS_LOCAL_MODE) {
      setShares([]);
      return;
    }
    void load();
  }, []);

  const revoke = async (share: Share) => {
    setBusy(share.id);
    try {
      await api.deleteShare(share.id);
      push('Ссылка отозвана');
      await load();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось отозвать', 'error');
    } finally {
      setBusy(null);
    }
  };

  const rotate = async (share: Share) => {
    setBusy(share.id);
    try {
      const next = await api.rotateShare(share.id);
      await navigator.clipboard.writeText(next.url).catch(() => {});
      push('Новая ссылка скопирована, старая больше не работает');
      await load();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось перевыпустить', 'error');
    } finally {
      setBusy(null);
    }
  };

  if (IS_LOCAL_MODE) {
    return (
      <section className="page">
        <header className="page__head">
          <div>
            <h1>Ссылки</h1>
            <p>Приватные ссылки живут на сервере</p>
          </div>
        </header>
        <div className="empty">
          <div className="empty__icon">
            <Icon name="share" size={30} />
          </div>
          <h3>В локальном режиме ссылок нет</h3>
          <p>
            Здесь библиотека хранится в браузере, и отдать файл другу некому. Запустите сервер
            (<code>npm start</code>) — и ссылка откроется у любого, кому вы её отправите.
          </p>
        </div>
      </section>
    );
  }

  const all = shares ?? [];
  const visible = all.filter((share) => showDead || !isDeadShare(share));
  const deadCount = all.filter(isDeadShare).length;

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1>Ссылки</h1>
          <p>Что вы отправили, сколько раз открыли и что уже не работает</p>
        </div>
        {deadCount > 0 && (
          <div className="page__tools">
            <button type="button" className="btn btn--ghost" onClick={() => setShowDead((value) => !value)}>
              {showDead ? 'Скрыть неактивные' : `Показать неактивные (${deadCount})`}
            </button>
          </div>
        )}
      </header>

      {shares === null && (
        <div className="skeleton-list">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="skeleton-row" />
          ))}
        </div>
      )}

      {shares !== null && visible.length === 0 && (
        <div className="empty">
          <div className="empty__icon">
            <Icon name="share" size={30} />
          </div>
          <h3>Пока ни одной ссылки</h3>
          <p>
            Меню трека → «Поделиться ссылкой» или кнопка «Ссылка» на странице плейлиста.
            Гость откроет плеер без пароля и сможет скачать файл.
          </p>
        </div>
      )}

      {shares !== null && visible.length > 0 && (
        <div className="shares">
          {visible.map((share) => {
            const track = share.targetKind === 'track' ? tracksById.get(share.targetId) : null;
            const playlist = share.targetKind === 'playlist'
              ? playlists.find((item) => item.id === share.targetId)
              : null;
            const dead = isDeadShare(share);
            const hits = share.stats?.hits ?? {};
            return (
              <div key={share.id} className={`shares__row${dead ? ' is-dead' : ''}`}>
                {track ? (
                  <Cover track={track} size={44} />
                ) : (
                  <span className="brand__mark" aria-hidden="true">
                    <Icon name="disc" size={18} />
                  </span>
                )}
                <div className="shares__meta">
                  <strong>{share.title || track?.title || playlist?.name || 'Ссылка'}</strong>
                  <span>
                    {share.targetKind === 'track' ? 'трек' : 'плейлист'}
                    {track ? ` · ${track.artist}` : playlist ? ` · ${playlist.trackCount} треков` : ' · удалено'}
                    {' · '}
                    {dead
                      ? share.revokedAt
                        ? 'отозвана'
                        : 'истекла'
                      : share.expiresAt
                        ? `до ${new Date(share.expiresAt).toLocaleDateString('ru-RU')}`
                        : 'бессрочная'}
                  </span>
                  <span className="muted">
                    открытий {share.plays}
                    {share.maxPlays ? ` из ${share.maxPlays}` : ''} · прослушиваний {hits.stream ?? 0} ·
                    скачиваний {hits.download ?? 0} · гостей {share.stats?.visitors ?? 0}
                  </span>
                </div>
                {!dead && (
                  <div className="shares__actions">
                    <button
                      type="button"
                      className="btn btn--small btn--ghost"
                      disabled={busy === share.id}
                      onClick={() => void rotate(share)}
                    >
                      Перевыпустить
                    </button>
                    <button
                      type="button"
                      className="btn btn--small btn--ghost"
                      disabled={busy === share.id}
                      onClick={() => void revoke(share)}
                    >
                      Отозвать
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function isDeadShare(share: Share): boolean {
  if (share.revokedAt) return true;
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) return true;
  if (share.maxPlays !== null && share.plays >= share.maxPlays) return true;
  return false;
}

/**
 * Дашборд владельца (D1): что слушают и когда.
 *
 * Это не аналитика по людям: адресов нет, география — по короткому отпечатку
 * хеша. Поэтому вместо карты — «сколько разных мест» и «мои прослушивания против
 * гостевых по ссылкам»: цифра «20 по ссылкам» и «3 моих» отвечают на разные
 * вопросы, и смешивать их в одну было бы враньём.
 *
 * График — обычные div-ы, без библиотеки: тридцать столбиков не стоят лишних
 * 40 КБ в бандле, а шкала считается из максимума.
 */
/** «2 часа назад» для дашборда: точная дата в таблице мешает читать. */
function ago(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 'неизвестно когда';
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

export function DashboardPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (IS_LOCAL_MODE) return;
    let cancelled = false;
    setData(null);
    api
      .dashboard(days)
      .then((result) => {
        if (!cancelled) {
          setError(null);
          setData(result);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Не удалось получить статистику');
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  if (IS_LOCAL_MODE) {
    return (
      <section className="page">
        <header className="page__head">
          <div>
            <h1>Дашборд</h1>
            <p>Прослушивания по дням, топ-треки, источники</p>
          </div>
        </header>
        <div className="empty">
          <h3>Здесь нужен сервер</h3>
          <p>
            Дашборд считает прослушивания на сервере. В локальном режиме (GitHub Pages)
            история не ведётся — откройте свою копию Vision Server.
          </p>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="page">
        <div className="empty">
          <h3>Дашборд не открылся</h3>
          <p>{error}</p>
        </div>
      </section>
    );
  }

  const maxPlays = Math.max(1, ...(data?.byDay ?? []).map((day) => day.plays));
  const cards = [
    { label: 'Прослушиваний', value: data?.totals.plays ?? 0, icon: 'play' },
    { label: 'Дослушано до конца', value: data?.totals.completed ?? 0, icon: 'check' },
    { label: 'Треков звучало', value: data?.totals.tracks ?? 0, icon: 'music' },
    { label: 'По ссылкам', value: data?.totals.sharedPlays ?? 0, icon: 'share' },
  ];

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1>Дашборд</h1>
          <p>
            {data
              ? `Прослушивания за ${data.days} ${data.days === 1 ? 'день' : 'дней'} · свои и гостевые`
              : 'Загружаем…'}
          </p>
        </div>
        <div className="page__tools">
          {[7, 30, 90].map((value) => (
            <button
              key={value}
              type="button"
              className={`btn btn--sm${days === value ? ' btn--primary' : ' btn--ghost'}`}
              onClick={() => setDays(value)}
            >
              {value} дней
            </button>
          ))}
        </div>
      </header>

      <div className="cards">
        {cards.map((card) => (
          <div key={card.label} className="card">
            <span className="card__icon">
              <Icon name={card.icon} size={18} />
            </span>
            <strong>{card.value}</strong>
            <span>{card.label}</span>
          </div>
        ))}
      </div>

      {!data && (
        <div className="skeleton-list">
          {Array.from({ length: 2 }).map((_, index) => (
            <div key={index} className="skeleton-row" />
          ))}
        </div>
      )}

      {data && !data.totals.plays && (
        <div className="empty">
          <h3>Пока тихо</h3>
          <p>{data.hint ?? 'Включите трек — и здесь появится статистика.'}</p>
        </div>
      )}

      {data && data.totals.plays > 0 && (
        <div className="panel-grid">
          <div className="panel">
            <h2>По дням</h2>
            <div className="dashboard-chart" role="img" aria-label={`Прослушивания за ${data.days} дней`}>
              {data.byDay.map((day) => (
                <div className="dashboard-chart__col" key={day.day} title={`${day.day}: ${day.plays}`}>
                  <i
                    className={day.shared ? 'is-shared' : undefined}
                    style={{ height: `${Math.max(2, (day.plays / maxPlays) * 100)}%` }}
                  />
                </div>
              ))}
            </div>
            <div className="dashboard-chart__axis">
              <span>{data.byDay[0]?.day.slice(5)}</span>
              <span>{data.byDay.at(-1)?.day.slice(5)}</span>
            </div>
            <p className="muted">
              Свои: {data.sources.owner} · по ссылкам: {data.sources.share} · повтор одного
              трека в течение получаса считается один раз.
            </p>
          </div>

          <div className="panel">
            <h2>Топ треков</h2>
            <ol className="dashboard-top">
              {data.topTracks.map((track) => (
                <li key={track.id}>
                  <span>
                    {track.deleted ? (
                      <em className="muted">трек удалён из библиотеки</em>
                    ) : (
                      <a href={`#/track/${track.id}`}>{track.title}</a>
                    )}
                    {track.artist ? <small> · {track.artist}</small> : null}
                  </span>
                  <b>
                    {track.plays}
                    {track.completed ? <small> / {track.completed} до конца</small> : null}
                  </b>
                </li>
              ))}
            </ol>
            {!data.topTracks.length && <p className="muted">Топ появится после прослушиваний.</p>}
          </div>

          <div className="panel dashboard-panel--wide">
            <h2>Откуда слушают</h2>
            {data.listeners.length ? (
              <>
                <ul className="dashboard-listeners">
                  {data.listeners.map((listener) => (
                    <li key={listener.id}>
                      <code>{listener.id}</code>
                      <span>
                        {listener.plays} прослушиваний · {listener.tracks} треков
                      </span>
                      <small className="muted">последний раз {ago(listener.lastSeen)}</small>
                    </li>
                  ))}
                </ul>
                <p className="muted">
                  Адреса не хранятся: отпечаток — это начало sha256 от адреса. Так видно «слушают
                  из одного места или из десяти», но не кто именно.
                </p>
              </>
            ) : (
              <p className="muted">Данных об адресах нет: прослушивания шли без сохранённого адреса.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export function StatsPage() {
  const { stats, tracks } = useLibrary();
  const offline = useOffline();
  const [limit, setLimit] = useState(() => String(offline.limitMb));
  // Снимок библиотеки (I5): показывает, что откроется без сети. Читаем один раз
  // при входе на страницу — снимок меняется только после ответа сервера.
  const snapshot = useMemo(() => readSnapshot({ base: apiBase() }), []);
  const libraryCache = IS_LOCAL_MODE
    ? 'не нужен: в локальном режиме библиотека уже в браузере'
    : snapshot
      ? `${snapshot.tracks.length}${snapshot.total > snapshot.tracks.length ? ` из ${snapshot.total}` : ''} треков, ${snapshotAge(snapshot.savedAt)}`
      : 'ещё не сохранён — появится после первой загрузки библиотеки при связи с сервером';

  const cards = [
    { label: 'Треков', value: String(stats?.tracks ?? 0), icon: 'music' },
    { label: 'Плейлистов', value: String(stats?.playlists ?? 0), icon: 'disc' },
    { label: 'Лайков', value: String(stats?.liked ?? 0), icon: 'heart' },
    { label: 'Прослушиваний', value: String(stats?.plays ?? 0), icon: 'play' },
  ];

  const maxGenre = Math.max(1, ...(stats?.genres ?? []).map((item) => item.count));

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1>Статистика</h1>
          <p>Ваша библиотека в цифрах</p>
        </div>
      </header>

      <div className="cards">
        {cards.map((card) => (
          <div key={card.label} className="card">
            <span className="card__icon">
              <Icon name={card.icon} size={18} />
            </span>
            <strong>{card.value}</strong>
            <span>{card.label}</span>
          </div>
        ))}
      </div>

      <div className="panel-grid">
        <div className="panel">
          <h2>Жанры</h2>
          {(stats?.genres ?? []).length === 0 && <p className="muted">Жанры появятся после загрузки треков с тегами.</p>}
          <div className="genre-bars">
            {(stats?.genres ?? []).slice(0, 8).map((item) => (
              <div key={item.genre} className="genre-bar">
                <span>{item.genre}</span>
                <div>
                  <i style={{ width: `${(item.count / maxGenre) * 100}%` }} />
                </div>
                <b>{item.count}</b>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <h2>Хранилище</h2>
          <dl className="facts">
            <div>
              <dt>Общее звучание</dt>
              <dd>{formatDuration(stats?.duration ?? 0)}</dd>
            </div>
            <div>
              <dt>Размер медиатеки</dt>
              <dd>{formatBytes(stats?.bytes ?? 0)}</dd>
            </div>
            <div>
              <dt>Свободно на диске</dt>
              <dd>{stats?.diskFreeMb ? `${(stats.diskFreeMb / 1024).toFixed(1)} ГБ` : '—'}</dd>
            </div>
            <div>
              <dt>Средняя длительность</dt>
              <dd>
                {stats?.tracks ? formatDuration(stats.duration / stats.tracks) : '—'}
              </dd>
            </div>
            <div>
              <dt>Версия API</dt>
              <dd>{stats?.version ?? '—'}</dd>
            </div>
            <div>
              <dt>Лайкнуто</dt>
              <dd>{tracks.filter((track) => track.liked).length} из {tracks.length}</dd>
            </div>
          </dl>
        </div>

        <div className="panel">
          <h2>Офлайн-копии</h2>
          {!offline.supported && (
            <p className="muted">
              Браузер отдаёт кэш только на HTTPS или localhost. Откройте сервер через Tailscale
              или Cloudflare Tunnel — и кнопка «Скачать офлайн» появится в меню трека.
            </p>
          )}
          {offline.supported && (
            <>
              <dl className="facts">
                <div>
                  <dt>Треков в кэше</dt>
                  <dd>
                    {offline.entries.length} из {tracks.length}
                  </dd>
                </div>
                <div>
                  <dt>Занято</dt>
                  <dd>
                    {formatOfflineBytes(offline.bytes)} из {offline.limitMb} МБ
                  </dd>
                </div>
                <div>
                  <dt>Что скачивать</dt>
                  <dd>Меню трека → «Скачать офлайн»</dd>
                </div>
                <div>
                  <dt>Список библиотеки</dt>
                  <dd>{libraryCache}</dd>
                </div>
              </dl>

              <div className="offline-actions">
                <label className="field field--inline">
                  <span>Лимит, МБ</span>
                  <input
                    type="number"
                    min={32}
                    max={8192}
                    step={32}
                    value={limit}
                    onChange={(event) => setLimit(event.target.value)}
                    onBlur={() => {
                      const value = Number(limit);
                      if (Number.isFinite(value) && value > 0) setOfflineLimitMb(value);
                      else setLimit(String(offline.limitMb));
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={offline.entries.length === 0}
                  onClick={() => {
                    if (!window.confirm('Удалить все офлайн-копии с этого устройства?')) return;
                    void clearOffline();
                  }}
                >
                  Очистить офлайн-кэш
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/* ---------------------- внешние ссылки (SoundCloud) ---------------------- */

/**
 * «Чужие» треки: у нас только метаданные, звук отдаёт официальный плеер
 * источника со своих серверов. Никакого скачивания и проксирования.
 */
export function ExternalPage() {
  const { push } = useToast();
  const [items, setItems] = useState<ExternalTrack[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ url: string; code: string; message: string }[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(!IS_LOCAL_MODE);
  const listInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (IS_LOCAL_MODE) return;
    let alive = true;
    api
      .external()
      .then((list) => {
        if (alive) setItems(list);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const urls = input
      .split(/[\n,]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (!urls.length) return;

    setBusy(true);
    setFailed([]);
    try {
      const result = await api.importExternal(urls);
      setItems((prev) => {
        const known = new Set(prev.map((item) => item.id));
        return [...result.added.filter((item) => !known.has(item.id)), ...prev];
      });
      setFailed(result.failed);
      setInput('');
      const updated = result.added.filter((item) => !item.created).length;
      if (result.added.length) {
        push(
          updated
            ? `Добавлено ${result.added.length - updated}, обновлено ${updated}`
            : `Добавлено ссылок: ${result.added.length}`
        );
      }
      if (!result.added.length && result.failed.length) push(result.failed[0].message, 'error');
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось добавить ссылки', 'error');
    } finally {
      setBusy(false);
    }
  };

  /** Массовый импорт из .txt/.csv: достаём ссылки, шлём пачками по 50. */
  const importList = async (file: File) => {
    setBusy(true);
    setFailed([]);
    try {
      const text = await file.text();
      const urls = Array.from(text.matchAll(/https?:\/\/[^\s,"']+/g)).map((match) => match[0]);
      if (!urls.length) {
        push('В файле не нашлось ссылок', 'error');
        return;
      }

      let addedCount = 0;
      const collected: ExternalTrack[] = [];
      const problems: { url: string; code: string; message: string }[] = [];

      for (let i = 0; i < urls.length; i += 50) {
        try {
          const result = await api.importExternal(urls.slice(i, i + 50));
          collected.push(...result.added);
          addedCount += result.added.length;
          problems.push(...result.failed);
        } catch (error) {
          problems.push({
            url: `${i + 1}–${Math.min(urls.length, i + 50)}`,
            code: 'batch_failed',
            message: error instanceof Error ? error.message : 'Пачка не загрузилась',
          });
        }
      }

      setItems((prev) => {
        const known = new Set(prev.map((item) => item.id));
        return [...collected.filter((item) => !known.has(item.id)), ...prev];
      });
      setFailed(problems);
      push(`Из файла добавлено: ${addedCount} из ${urls.length}`);
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось прочитать файл', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: ExternalTrack) => {
    try {
      await api.deleteExternal(item.id);
      setItems((prev) => prev.filter((entry) => entry.id !== item.id));
      if (openId === item.id) setOpenId(null);
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось удалить ссылку', 'error');
    }
  };

  if (IS_LOCAL_MODE) {
    return (
      <section className="page">
        <header className="page__head">
          <div>
            <h1>Из SoundCloud</h1>
            <p>Раздел работает в режиме с сервером — в статической версии внешние ссылки не хранятся.</p>
          </div>
        </header>
        <div className="empty">
          <div className="empty__icon">
            <Icon name="external" size={34} />
          </div>
          <h3>Нужен сервер Vision Audio</h3>
          <p>
            Запустите <code>npm start</code> и откройте приложение по адресу API — тогда ссылки
            на треки SoundCloud можно будет собирать в отдельную полку.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1>Из SoundCloud</h1>
          <p>{items.length} внешних ссылок · звук играет официальный плеер источника</p>
        </div>
      </header>

      <form className="import" onSubmit={submit}>
        <label className="import__label" htmlFor="import-urls">
          Ссылки на треки или плейлисты — по одной в строке
        </label>
        <textarea
          id="import-urls"
          className="import__area"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={'https://soundcloud.com/artist/track\nhttps://soundcloud.com/artist/sets/playlist'}
          rows={3}
          spellCheck={false}
        />
        <div className="import__actions">
          <button type="submit" className="btn btn--primary" disabled={busy || !input.trim()}>
            <Icon name="plus" size={16} />
            {busy ? 'Проверяем ссылки…' : 'Добавить'}
          </button>
          <button
            type="button"
            className="btn btn--small"
            disabled={busy}
            onClick={() => listInput.current?.click()}
          >
            Список из .txt/.csv
          </button>
          <input
            ref={listInput}
            type="file"
            accept=".txt,.csv,text/plain,text/csv"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importList(file);
              event.target.value = '';
            }}
          />
          <span className="import__hint">
            Сохраняются только название, автор и код официального плеера. Аудио не скачивается.
          </span>
        </div>
      </form>

      {failed.length > 0 && (
        <ul className="import__errors" role="alert">
          {failed.map((item) => (
            <li key={item.url}>
              <code>{item.url}</code> — {item.message}
            </li>
          ))}
        </ul>
      )}

      {loading ? (
        <div className="skeleton-list">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="skeleton-row" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="empty">
          <div className="empty__icon">
            <Icon name="external" size={34} />
          </div>
          <h3>Пока ни одной ссылки</h3>
          <p>
            Вставьте ссылку на публичный трек — появится карточка с кнопкой «Слушать». Трек
            останется на серверах SoundCloud, а у нас будет только закладка.
          </p>
        </div>
      ) : (
        <div className="external-grid">
          {items.map((item) => {
            const hue = (item.title.charCodeAt(0) * 37 + item.title.length * 13) % 360;
            const open = openId === item.id;
            return (
              <article key={item.id} className={`external${open ? ' is-open' : ''}`}>
                <div
                  className="external__cover"
                  style={{ background: `linear-gradient(135deg, hsl(${hue} 62% 30%), hsl(${(hue + 50) % 360} 60% 16%))` }}
                  aria-hidden="true"
                >
                  {item.title.slice(0, 1).toUpperCase()}
                </div>

                <div className="external__body">
                  <strong className="external__title" title={item.title}>
                    {item.title}
                  </strong>
                  <span className="external__artist">{item.artist ?? 'Неизвестный автор'}</span>
                  <span className="external__badge">SoundCloud · не хранится у нас</span>
                </div>

                <div className="external__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : item.id)}
                  >
                    <Icon name={open ? 'pause' : 'play'} size={14} />
                    {open ? 'Свернуть' : 'Слушать'}
                  </button>
                  <a
                    className="btn btn--ghost btn--sm"
                    href={item.permalink}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Открыть
                    <Icon name="external" size={13} />
                  </a>
                  <button
                    type="button"
                    className="iconbtn"
                    aria-label={`Удалить ссылку ${item.title}`}
                    onClick={() => void remove(item)}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>

                {open && (
                  <div className="external__player">
                    <iframe
                      title={`Плеер SoundCloud: ${item.title}`}
                      width="100%"
                      height={166}
                      loading="lazy"
                      allow="autoplay; encrypted-media"
                      src={item.embedUrl}
                    />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
