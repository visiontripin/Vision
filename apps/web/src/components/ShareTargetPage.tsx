import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { parseShareTarget, type SharePayload } from '../deep-link';
import { useLibrary } from '../state/library';
import { Icon, useToast } from '../ui';

/**
 * Приём файла и ссылки из системного меню «Поделиться» (PWA share target, F1).
 *
 * Почему страница, а не скрытый редирект: Android приводит сюда человека, который
 * только что выбрал «Vision» в чужом приложении. Он должен увидеть, **что** сейчас
 * произойдёт, и подтвердить это одной кнопкой. Автоматическая загрузка по ссылке
 * из чужого приложения — это способ залить на сервер что угодно без спроса.
 *
 * Что принимаем:
 *  - `files` — файл из меню «Поделиться» (Android кладёт его в GET-параметры, только
 *    если он маленький; большие не приходят вовсе — об этом честно написано);
 *  - `url`/`text` — ссылку на аудиофайл: скачиваем и загружаем с подтверждением;
 *  - пусто — обычная загрузка из библиотеки.
 */
export function ShareTargetPage() {
  const { reload } = useLibrary();
  const { push } = useToast();
  const [payload, setPayload] = useState<SharePayload>(() => parseShareTarget(window.location.search));
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Ссылка «из чата» часто ведёт на нашу же ссылку — открываем её без загрузки. */
  const internalLink = useMemo(() => {
    if (payload.kind !== 'link' && payload.kind !== 'remote') return null;
    try {
      const url = new URL(payload.url);
      const track = /\/#?\/?track\/([a-f0-9]{32})/.exec(url.hash || url.pathname);
      if (track) return track[1];
      const share = /^\/s\/([A-Za-z0-9_-]{20,128})/.exec(url.pathname);
      if (share) return `${url.origin}/s/${share[1]}`;
      return null;
    } catch {
      return null;
    }
  }, [payload]);

  useEffect(() => {
    if (payload.kind === 'remote' || payload.kind === 'link') {
      // имя файла из адреса — лучшая догадка, человек поправит в поле
      const guess = decodeURIComponent(payload.url.split('/').pop()?.split('?')[0] || '');
      setTitle((payload.title || guess).replace(/\.[a-z0-9]{2,5}$/i, ''));
    }
    if (payload.kind === 'text') setTitle(payload.text.slice(0, 120));
  }, [payload]);

  /** Файл, если он всё-таки пришёл (мелкий файл или другой браузер). */
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const first = input.files?.[0];
    if (first) {
      setFile(first);
      setTitle((current) => current || first.name.replace(/\.[^.]+$/, ''));
    }
  }, []);

  const upload = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      if (file) {
        await api.uploadTrack(
          file,
          {
            title: title.trim() || file.name.replace(/\.[^.]+$/, ''),
            artist: 'Unknown',
            filename: file.name,
          },
          (percent) => setProgress(percent)
        );
        setDone(title.trim() || file.name);
      } else if (payload.kind === 'remote') {
        // скачиваем сами: CORS у чужого сервера может не быть, поэтому — через fetch,
        // а при ошибке честно просим сохранить файл и загрузить его вручную
        const response = await fetch(payload.url);
        if (!response.ok) throw new Error(`Сервер отдал ${response.status}`);
        const blob = await response.blob();
        const name = decodeURIComponent(payload.url.split('/').pop()?.split('?')[0] || 'audio');
        await api.uploadTrack(
          new File([blob], name, { type: blob.type || 'audio/mpeg' }),
          { title: title.trim() || name, artist: 'Unknown', filename: name },
          (percent) => setProgress(percent)
        );
        setDone(title.trim() || name);
      } else {
        throw new Error('Нечего загружать: выберите файл');
      }
      await reload();
      push('Трек добавлен в библиотеку');
      setPayload({ kind: 'empty' });
      setFile(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h1>Поделились с Vision</h1>
          <p>Приложение получило данные из системного меню «Поделиться»</p>
        </div>
      </header>

      {done && (
        <div className="card" style={{ display: 'grid', gap: 8 }}>
          <strong>«{done}» в библиотеке</strong>
          <div className="row" style={{ gap: 8 }}>
            <a className="btn btn--small" href="#/">Открыть библиотеку</a>
            <button type="button" className="btn btn--small btn--ghost" onClick={() => setDone(null)}>
              Поделиться ещё
            </button>
          </div>
        </div>
      )}

      {!done && internalLink && (
        <div className="card" style={{ display: 'grid', gap: 8 }}>
          <strong>Это ссылка Vision Audio</strong>
          <p className="muted">Её не нужно загружать — можно просто открыть.</p>
          <a className="btn btn--small" href={internalLink.startsWith('http') ? internalLink : `#/track/${internalLink}`}>
            Открыть ссылку
          </a>
        </div>
      )}

      {!done && (
        <div className="card" style={{ display: 'grid', gap: 10 }}>
          {file && (
            <p className="muted">
              Файл: <strong>{file.name}</strong> · {(file.size / 1024 / 1024).toFixed(1)} МБ
            </p>
          )}
          {!file && payload.kind === 'remote' && (
            <p className="muted">
              Ссылка на аудио: <span className="code">{payload.url}</span>
            </p>
          )}
          {!file && payload.kind === 'link' && !internalLink && (
            <p className="muted">
              Пришла ссылка на страницу, а не на файл. Скачайте аудио и загрузите его —
              или вставьте прямую ссылку.
            </p>
          )}
          {payload.kind === 'text' && !file && (
            <p className="muted">Пришёл текст без ссылки. Можно загрузить файл вручную.</p>
          )}
          {payload.kind === 'empty' && !file && (
            <p className="muted">
              Данных не пришло. Выберите файл — или откройте обычную загрузку в библиотеке.
            </p>
          )}

          <label className="field">
            <span>Название</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} />
          </label>

          <input
            ref={inputRef}
            type="file"
            accept="audio/*"
            onChange={(event) => {
              const first = event.target.files?.[0] ?? null;
              setFile(first);
              if (first) setTitle((current) => current || first.name.replace(/\.[^.]+$/, ''));
            }}
          />

          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn btn--primary btn--small"
              disabled={busy || (!file && payload.kind !== 'remote')}
              onClick={() => void upload()}
            >
              <Icon name="upload" size={16} />
              {busy ? `Загружаю… ${progress}%` : 'Добавить в библиотеку'}
            </button>
            <a className="btn btn--small btn--ghost" href="#/">В библиотеку</a>
          </div>

          {busy && <progress value={progress} max={100} style={{ width: '100%' }} />}
          {error && <p className="error">{error}</p>}
          <p className="hint">
            Большие файлы Android в меню «Поделиться» не передаёт — для них выберите файл здесь.
            Ничего не загружается без нажатия кнопки.
          </p>
        </div>
      )}
    </section>
  );
}
