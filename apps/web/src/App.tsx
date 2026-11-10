import { useCallback, useEffect, useState } from 'react';
import { QueueDrawer, PlayerBar } from './components/PlayerBar';
import { Sidebar } from './components/Sidebar';
import { UploadModal } from './components/UploadModal';
import { Login } from './Login';
import {
  ExternalPage,
  LibraryPage,
  LikedPage,
  PlaylistPage,
  PlaylistsPage,
  StatsPage,
} from './pages';
import { AuthProvider, useAuth } from './state/auth';
import { LibraryProvider, useLibrary } from './state/library';
import { PlayerProvider, usePlayer } from './state/player';
import { Icon } from './ui';
import { ToastProvider } from './ui';

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Root />
      </ToastProvider>
    </AuthProvider>
  );
}

function Root() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <div className="splash">
        <span className="brand__mark brand__mark--lg">
          <Icon name="logo" size={30} />
        </span>
        <p>Vision Audio</p>
      </div>
    );
  }

  if (status === 'anon') return <Login />;

  return (
    <LibraryProvider>
      <PlayerProvider>
        <Shell />
      </PlayerProvider>
    </LibraryProvider>
  );
}

function useRoute() {
  const read = () => {
    const raw = window.location.hash.replace(/^#/, '');
    return raw || '/';
  };
  const [route, setRoute] = useState(read);

  useEffect(() => {
    const onHash = () => {
      setRoute(read());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return route;
}

function Shell() {
  const route = useRoute();
  const { error, reload, tracks } = useLibrary();
  const player = usePlayer();
  const [search, setSearch] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[] | null>(null);
  const [drawerHint, setDrawerHint] = useState(false);

  useEffect(() => {
    if (player.current) setDrawerHint(false);
  }, [player.current]);

  useEffect(() => {
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files);
      if (!files.length) return;
      setDroppedFiles(files);
      setUploadOpen(true);
    };
    const onOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragover', onOver);
    return () => {
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', onOver);
    };
  }, []);

  const clearDroppedFiles = useCallback(() => setDroppedFiles(null), []);

  const openUpload = () => {
    setUploadOpen(true);
    if (!tracks.length) setDrawerHint(true);
  };

  const playlistMatch = /^\/playlists\/([a-f0-9]{32})$/.exec(route);

  const content = (() => {
    if (playlistMatch) return <PlaylistPage key={playlistMatch[1]} id={playlistMatch[1]} search={search} />;
    if (route === '/liked') return <LikedPage />;
    if (route === '/playlists') return <PlaylistsPage />;
    if (route === '/stats') return <StatsPage />;
    if (route === '/external') return <ExternalPage />;
    return <LibraryPage search={search} onUpload={openUpload} />;
  })();

  return (
    <div className="app">
      <Sidebar route={route} onUpload={openUpload} />

      <main className="main">
        <header className="topbar">
          <a className="topbar__brand" href="#/" aria-label="Vision Audio">
            <span className="brand__mark">
              <Icon name="logo" size={18} />
            </span>
            <strong>Vision</strong>
          </a>

          <label className="search">
            <Icon name="search" size={17} />
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                if (route !== '/' && route !== '/liked' && !playlistMatch) {
                  window.location.hash = '#/';
                }
              }}
              placeholder="Поиск по трекам, артистам, жанрам"
              aria-label="Поиск"
              type="search"
            />
            {search && (
              <button type="button" className="iconbtn" aria-label="Очистить поиск" onClick={() => setSearch('')}>
                <Icon name="close" size={15} />
              </button>
            )}
          </label>

          <button type="button" className="btn btn--primary topbar__upload" onClick={openUpload}>
            <Icon name="upload" size={16} />
            <span>Загрузить</span>
          </button>
        </header>

        <nav className="mobileNav" aria-label="Разделы">
          <a href="#/" className={route === '/' ? 'is-active' : ''}>Библиотека</a>
          <a href="#/liked" className={route === '/liked' ? 'is-active' : ''}>Лайки</a>
          <a href="#/playlists" className={route.startsWith('/playlists') ? 'is-active' : ''}>Плейлисты</a>
          <a href="#/stats" className={route === '/stats' ? 'is-active' : ''}>Статистика</a>
          <a href="#/external" className={route === '/external' ? 'is-active' : ''}>SoundCloud</a>
        </nav>

        {error && (
          <div className="banner" role="alert">
            <span>{error}</span>
            <button type="button" className="btn btn--small" onClick={() => void reload()}>
              Повторить
            </button>
          </div>
        )}

        {drawerHint && !tracks.length && (
          <div className="banner banner--info">
            <span>Перетащите аудиофайлы в открывшееся окно — метаданные и волна посчитаются автоматически.</span>
            <button type="button" className="iconbtn" aria-label="Скрыть" onClick={() => setDrawerHint(false)}>
              <Icon name="close" size={15} />
            </button>
          </div>
        )}

        <div className={`content${player.current ? ' content--player' : ''}`}>{content}</div>
      </main>

      <PlayerBar />
      <QueueDrawer />

      <UploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        initialFiles={droppedFiles}
        onFilesConsumed={clearDroppedFiles}
      />
    </div>
  );
}
