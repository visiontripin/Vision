import { useEffect, useMemo, useState } from 'react';
import { formatDuration, type Playlist, type Track } from '@vision/shared';
import { api } from './api';
import { TrackList } from './components/TrackList';
import { useLibrary } from './state/library';
import { usePlayer } from './state/player';
import { Icon, useToast } from './ui';

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

export function LibraryPage({ search, onUpload }: LibraryProps) {
  const { tracks, stats, loading } = useLibrary();
  const player = usePlayer();
  const [genre, setGenre] = useState<string | null>(null);
  const [sort, setSort] = useState<SortValue>('recent');
  const filtered = useFilteredTracks(tracks, search, genre, sort);

  const genres = stats?.genres ?? [];

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1>Библиотека</h1>
          <p>
            {tracks.length} треков · {formatDuration(stats?.duration ?? 0)} звучания
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
