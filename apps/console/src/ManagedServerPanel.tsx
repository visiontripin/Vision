import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { ConsoleClient, normalizeBase, type Health } from './api';

type ManagedServerStatus = {
  supported: boolean;
  running: boolean;
  managed: boolean;
  ownerConfigured: boolean;
  port: number;
  baseUrl: string;
  dataDir: string;
  logPath: string;
  message: string | null;
};

type Props = {
  base: string;
  token: string;
  onSetAddress: (base: string) => void;
  onStarted: (base: string, token: string, health: Health) => void;
  onStopped: (base: string) => void;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameAddress(left: string, right: string): boolean {
  return Boolean(left && right && normalizeBase(left) === normalizeBase(right));
}

export function ManagedServerPanel({ base, token, onSetAddress, onStarted, onStopped }: Props) {
  const inTauri = isTauri();
  const [status, setStatus] = useState<ManagedServerStatus | null>(null);
  const [port, setPort] = useState('4000');
  const [password, setPassword] = useState('');
  const [logs, setLogs] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const portInitialized = useRef(false);

  const refreshStatus = useCallback(async () => {
    if (!inTauri) return;
    try {
      const next = await invoke<ManagedServerStatus>('managed_server_status');
      setStatus(next);
      if (!portInitialized.current) {
        setPort(String(next.port || 4000));
        portInitialized.current = true;
      }
      if (next.supported && next.running && !base) onSetAddress(next.baseUrl);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [inTauri, base, onSetAddress]);

  useEffect(() => {
    if (!inTauri) return;
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 2500);
    return () => clearInterval(timer);
  }, [inTauri, refreshStatus]);

  const readLogs = async () => {
    try {
      setLogs(await invoke<string>('read_managed_server_logs'));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const start = async () => {
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      setError('Введите порт от 1 до 65535.');
      return;
    }
    if (password.trim().length < 12) {
      setError('Пароль владельца должен содержать не менее 12 символов.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const next = await invoke<ManagedServerStatus>('start_managed_server', {
        password: password.trim(),
        port: portNumber,
      });
      setStatus(next);
      setPort(String(next.port));
      const client = new ConsoleClient(next.baseUrl);
      const health = await client.health();
      const session = await client.login(password.trim());
      onStarted(next.baseUrl, session.token, health);
      setPassword('');
      await refreshStatus();
    } catch (cause) {
      setError(messageOf(cause));
      await refreshStatus();
      await readLogs();
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!status) return;
    const localConnection = sameAddress(base, status.baseUrl) && Boolean(token);
    setBusy(true);
    setError(null);
    try {
      // Останавливаем именно установленную Windows-службу, а не только дочерний
      // Node-процесс: API-shutdown без SCM-команды может привести к перезапуску.
      await invoke('stop_managed_server', { token: localConnection ? token : null });

      let finalStatus = status;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        finalStatus = await invoke<ManagedServerStatus>('managed_server_status');
        setStatus(finalStatus);
        if (!finalStatus.running) break;
      }
      if (!finalStatus.running) {
        if (sameAddress(base, status.baseUrl)) onStopped(status.baseUrl);
        setLogs(null);
      } else {
        setError('Сервер ещё завершает работу. Обновите состояние через секунду.');
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!inTauri || !status?.supported) return null;

  const localConnection = sameAddress(base, status.baseUrl) && Boolean(token);
  const canStop = status.managed;

  return (
    <section className="card">
      <div className="card__head">
        <div>
          <h2>Сервер на этом ПК</h2>
          <p className="muted">
            Служба Windows · автозапуск при загрузке · {status.running ? `порт ${status.port}` : 'остановлена'}
          </p>
        </div>
        <span className={`badge ${status.running ? 'badge--ok' : ''}`}>
          {status.running ? 'работает' : 'остановлен'}
        </span>
      </div>

      {status.message && <p className="hint">{status.message}</p>}

      {status.running && (
        <>
          <div className="check">
            <span className="check__dot check__dot--ok" />
            <div>
              <div className="check__title">Локальный API</div>
              <div className="check__detail"><code>{status.baseUrl}</code></div>
            </div>
          </div>
          <p className="hint">
            Телефон подключается по IPv4 этого ПК в домашней Wi-Fi-сети, например{' '}
            <code>http://192.168.1.20:{status.port}</code>. Не публикуйте порт напрямую в интернете.
          </p>
          <p className="hint">
            Данные: <code>{status.dataDir}</code><br />
            Журналы службы: <code>{status.logPath}</code>
          </p>
          <div className="row">
            {!localConnection && (
              <button type="button" className="btn btn--small btn--ghost" onClick={() => onSetAddress(status.baseUrl)}>
                Подставить адрес в панель
              </button>
            )}
            <button type="button" className="btn btn--small btn--ghost" onClick={() => void readLogs()}>
              Журнал службы
            </button>
            <button type="button" className="btn btn--small" onClick={() => void refreshStatus()} disabled={busy}>
              Обновить
            </button>
            <button type="button" className="btn btn--small btn--danger" onClick={() => void stop()} disabled={!canStop || busy}>
              {busy ? 'Останавливаю…' : 'Остановить службу'}
            </button>
          </div>
        </>
      )}

      {(!status.running || !status.ownerConfigured) && (
        <>
          <div className="row">
            <label className="field" style={{ flex: '0 0 140px' }}>
              <span>Порт</span>
              <input
                type="number"
                min="1"
                max="65535"
                value={port}
                onChange={(event) => setPort(event.target.value)}
              />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Пароль владельца · минимум 12 символов</span>
              <input
                type="password"
                value={password}
                autoComplete="new-password"
                onChange={(event) => setPassword(event.target.value)}
                placeholder={status.running
                  ? (status.ownerConfigured ? 'Введите пароль владельца' : 'Придумайте пароль для сервера')
                  : 'Введите пароль владельца'}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && password.trim().length >= 12) void start();
                }}
              />
            </label>
          </div>
          <button type="button" className="btn btn--primary btn--block" onClick={() => void start()} disabled={busy || password.trim().length < 12}>
            {busy
              ? 'Запускаю службу…'
              : status.running
                ? 'Сохранить пароль и подключиться'
                : 'Запустить службу и подключиться'}
          </button>
          <p className="hint">
            {status.running && !status.ownerConfigured
              ? 'При первом запуске пароль сохраняется только в виде стойкого хеша и не публикуется в домашней сети до завершения настройки.'
              : 'Служба стартует отдельно от окна Vision Server и работает при включённом ПК.'}
            {' '}Для доступа с телефона разрешайте входящие соединения только в частных сетях.
          </p>
        </>
      )}

      {logs !== null && (
        <details className="server-logs" open>
          <summary>Последние строки журнала</summary>
          <pre className="code">{logs || 'Журнал пока пуст.'}</pre>
        </details>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
