import { useState } from 'react';
import { apiBase, saveApiBase } from './api';
import { useAuth } from './state/auth';
import { Icon } from './ui';

export function Login() {
  const { login, busy } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [server, setServer] = useState(apiBase());
  const [showServer, setShowServer] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      if (showServer) saveApiBase(server.trim());
      await login(password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось войти');
    }
  };

  return (
    <div className="login">
      <div className="login__glow" aria-hidden="true" />
      <main className="login__card">
        <div className="login__brand">
          <span className="brand__mark brand__mark--lg">
            <Icon name="logo" size={30} />
          </span>
          <span>
            <strong>Vision</strong>
            <em>audio</em>
          </span>
        </div>

        <h1>
          Ваша музыка.
          <br />
          Только ваша.
        </h1>
        <p className="login__lead">
          Личная библиотека, волновой плеер и плейлисты. Без рекламы, рекомендаций и чужих глаз.
        </p>

        <form className="login__form" onSubmit={submit}>
          <label className="field">
            <span>Пароль</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
              autoComplete="current-password"
              placeholder="••••••"
              aria-invalid={Boolean(error)}
            />
          </label>

          {error && <div className="login__error" role="alert">{error}</div>}

          <button type="submit" className="btn btn--primary btn--block btn--lg" disabled={busy || !password}>
            {busy ? 'Проверяем…' : 'Войти в библиотеку'}
          </button>
        </form>

        <button type="button" className="login__toggle" onClick={() => setShowServer((value) => !value)}>
          {showServer ? 'Скрыть настройки сервера' : 'Подключиться к своему серверу'}
        </button>

        {showServer && (
          <label className="field">
            <span>Адрес API</span>
            <input
              value={server}
              onChange={(event) => setServer(event.target.value)}
              placeholder="например, http://192.168.1.10:4000"
              inputMode="url"
            />
            <small>Оставьте пустым, если клиент открыт с того же сервера.</small>
          </label>
        )}

        <ul className="login__features">
          <li>
            <Icon name="upload" size={15} /> Drag&drop загрузка с волной
          </li>
          <li>
            <Icon name="disc" size={15} /> Плейлисты и лайки
          </li>
          <li>
            <Icon name="queue" size={15} /> Очередь, shuffle, повтор
          </li>
        </ul>

        <p className="login__hint">
          Демо-пароль по умолчанию: <code>vision</code>. Задайте свой через переменную окружения
          <code> VISION_PASSWORD</code>.
        </p>
      </main>

      <footer className="login__foot">Vision Audio · v0.1 · web · android · ios · windows · linux</footer>
    </div>
  );
}
