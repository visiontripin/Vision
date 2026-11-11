import { formatBytes } from '@vision/shared';
import { IS_LOCAL_MODE } from '../api';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { Icon } from '../ui';

const NAV = [
  { href: '#/', label: 'Библиотека', icon: 'home' },
  { href: '#/for-you', label: 'Для вас', icon: 'sparkle' },
  { href: '#/liked', label: 'Лайкнутое', icon: 'heart' },
  { href: '#/playlists', label: 'Плейлисты', icon: 'disc' },
  { href: '#/stats', label: 'Статистика', icon: 'stats' },
  { href: '#/shares', label: 'Ссылки', icon: 'share' },
  { href: '#/external', label: 'Из SoundCloud', icon: 'external' },
];

export function Sidebar({ route, onUpload }: { route: string; onUpload: () => void }) {
  const { playlists, stats } = useLibrary();
  const { logout } = useAuth();

  const isActive = (href: string) => {
    const path = href.slice(1);
    if (path === '/') return route === '/' || route === '';
    return route === path || route.startsWith(`${path}/`);
  };

  return (
    <aside className="sidebar">
      <a className="brand" href="#/" aria-label="Vision Audio — на главную">
        <span className="brand__mark">
          <Icon name="logo" size={22} />
        </span>
        <span>
          <strong>Vision</strong>
          <em>audio</em>
        </span>
      </a>

      <button type="button" className="btn btn--primary btn--block" onClick={onUpload}>
        <Icon name="upload" size={17} />
        Загрузить
      </button>

      <nav className="nav" aria-label="Разделы">
        {NAV.map(( item ) => (
          <a key={item.href} href={item.href} className={`nav__link${isActive(item.href) ? ' is-active' : ''}`}>
            <Icon name={item.icon} size={18} />
            {item.label}
            {item.href === '#/liked' && stats?.liked ? <span className="nav__badge">{stats.liked}</span> : null}
          </a>
        ))}
      </nav>

      <div className="sidebar__section">
        <div className="sidebar__title">
          <span>Мои плейлисты</span>
          <a href="#/playlists" className="sidebar__add" aria-label="Все плейлисты">
            <Icon name="plus" size={14} />
          </a>
        </div>
        <div className="sidebar__playlists">
          {playlists.length === 0 && <p className="sidebar__hint">Пока пусто — создайте первый плейлист.</p>}
          {playlists.map((playlist) => (
            <a
              key={playlist.id}
              href={`#/playlists/${playlist.id}`}
              className={`sidebar__playlist${route === `/playlists/${playlist.id}` ? ' is-active' : ''}`}
              title={playlist.name}
            >
              <span>{playlist.name}</span>
              <span className="sidebar__count">{playlist.trackCount}</span>
            </a>
          ))}
        </div>
      </div>

      <footer className="sidebar__foot">
        <div className="storage">
          <div className="storage__row">
            <span>{IS_LOCAL_MODE ? 'Локальный режим' : 'Свободно на диске'}</span>
            <strong>
              {IS_LOCAL_MODE
                ? 'в браузере'
                : stats?.diskFreeMb
                  ? formatBytes(stats.diskFreeMb * 1024 * 1024)
                  : '—'}
            </strong>
          </div>
          <div className="storage__bar">
            <i style={{ width: `${Math.min(100, ((stats?.tracks ?? 0) / 200) * 100)}%` }} />
          </div>
          <p>{stats?.tracks ?? 0} треков · {Math.round((stats?.duration ?? 0) / 60)} мин</p>
        </div>
        {IS_LOCAL_MODE ? (
          <p className="sidebar__note" title="Треки хранятся в IndexedDB этого браузера">
            Данные — только в этом браузере
          </p>
        ) : (
          <button type="button" className="sidebar__logout" onClick={logout}>
            Выйти
          </button>
        )}
      </footer>
    </aside>
  );
}
