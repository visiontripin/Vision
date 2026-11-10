import { useEffect, useMemo, useState } from 'react';
import {
  formatBytes,
  formatDuration,
  type ExternalTrack,
  type HistoryEntry,
  type Playlist,
  type Track,
} from '@vision/shared';
import { api, IS_LOCAL_MODE } from './api';
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

      {playlists.length === 0 ? (
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

export function PlaylistPage({ id, search }: { id: string; search: string }) {
  const { playlists, reload } = useLibrary();
  const player = usePlayer();
  const { push } = useToast();
  const [tracks, setTracks] = useState<Track[] | null>(null);
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
    </section>
  );
}

export function StatsPage() {
  const { stats, tracks } = useLibrary();

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
