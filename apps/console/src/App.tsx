import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ConsoleClient, ConsoleError, baseHint, loadSession, normalizeBase, saveSession,
  type AuditPage, type BackupResult, type BackupStatus, type Dashboard, type Health,
} from './api';
import { adminUrl, ago, auditClock, diagnose, diskState, expiry, humanBytes, isReady, playsChart } from './lib';

/**
 * Vision Server — панель запуска и администрирования.
 *
 * Одна и та же сборка работает как:
 *  - окно Windows (Tauri): «сервер на этом ПК» — ярлык на localhost;
 *  - APK на Android: сервер в Wi-Fi, панель с телефона;
 *  - страница `/admin` самого сервера (в том числе redirect_url для
 *    мини-аппа Telegram).
 *
 * Поэтому экран один: «где сервер» → «пароль» → «как дела», без привязки к платформе.
 */

type Tab = 'overview' | 'plays' | 'shares' | 'library' | 'backups' | 'audit';

/** Фильтры журнала: «всё» и три группы, которые чаще всего нужны при разборе. */
const AUDIT_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'Всё' },
  { value: 'track', label: 'Треки' },
  { value: 'share', label: 'Ссылки' },
  { value: 'comment', label: 'Комментарии' },
  { value: 'auth', label: 'Входы' },
];

export function App() {
  const initial = useMemo(() => loadSession(), []);
  const [base, setBase] = useState(initial.base);
  const [token, setToken] = useState(initial.token);
  const [password, setPassword] = useState('');
  const [health, setHealth] = useState<Health | null>(null);
  const [stats, setStats] = useState<Awaited<ReturnType<ConsoleClient['stats']>> | null>(null);
  const [tracker, setTracker] = useState<Awaited<ReturnType<ConsoleClient['tracker']>> | null>(null);
  const [shares, setShares] = useState<Awaited<ReturnType<ConsoleClient['shares']>>>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [backups, setBackups] = useState<BackupStatus | null>(null);
  const [backupRun, setBackupRun] = useState<BackupResult | null>(null);
  const [backupCheck, setBackupCheck] = useState<
    { ok: boolean; problems: string[]; counts: Record<string, number | null>; checkedFiles: number; archive: string } | null
  >(null);
  const [plays, setPlays] = useState<Dashboard | null>(null);
  const [playsDays, setPlaysDays] = useState(30);
  const [audit, setAudit] = useState<AuditPage | null>(null);
  const [auditFilter, setAuditFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connected = Boolean(token);
  const checks = diagnose(health);

  const client = useMemo(() => new ConsoleClient(base, token), [base, token]);

  /** «Сервер на этом ПК»: панель, открытая самим сервером, живёт на том же origin. */
  const useThisMachine = () => {
    setBase('');
    setError(null);
  };

  const connect = async () => {
    const next = normalizeBase(base);
    setBusy('connect');
    setError(null);
    setHealth(null);
    try {
      const probe = new ConsoleClient(next, null);
      const info = await probe.health();
      setHealth(info);
      if (token) {
        saveSession(next, token);
        setBase(next);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Сервер не отвечает');
    } finally {
      setBusy(null);
    }
  };

  const login = async () => {
    const next = normalizeBase(base);
    setBusy('login');
    setError(null);
    try {
      const probe = new ConsoleClient(next, null);
      const result = await probe.login(password);
      setToken(result.token);
      saveSession(next, result.token);
      setBase(next);
      setPassword('');
    } catch (e) {
      const message = e instanceof ConsoleError ? e.message : 'Не удалось войти';
      setError(message);
    } finally {
      setBusy(null);
    }
  };

  const logout = () => {
    setToken('');
    saveSession(base, null);
    setStats(null);
    setTracker(null);
    setShares([]);
  };

  const refresh = useCallback(async () => {
    if (!connected) return;
    setBusy('refresh');
    setError(null);
    try {
      const [info, nextStats, nextTracker, nextShares] = await Promise.all([
        client.health(),
        client.stats(),
        client.tracker().catch(() => null),
        client.shares().catch(() => []),
      ]);
      setHealth(info);
      setStats(nextStats);
      setTracker(nextTracker);
      setShares(nextShares);
    } catch (e) {
      if (e instanceof ConsoleError && e.status === 401) {
        setToken('');
        saveSession(base, null);
        setError('Сессия истекла — войдите заново.');
      } else {
        setError(e instanceof Error ? e.message : 'Не удалось получить данные');
      }
    } finally {
      setBusy(null);
    }
  }, [client, connected, base]);

  useEffect(() => {
    if (connected) void refresh();
    // при старте — один раз, дальше по кнопке «Обновить»
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  /** Журнал грузится отдельно: он нужен только на своей вкладке и бывает длинным. */
  /** Копии: статус при входе на вкладку, создание и проверка — по кнопке. */
  const loadBackups = useCallback(async () => {
    setBusy('backups');
    try {
      setBackups(await client.backups());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось получить статус копий');
      setBackups(null);
    } finally {
      setBusy(null);
    }
  }, [client]);

  useEffect(() => {
    if (connected && tab === 'backups' && backups === null) void loadBackups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, tab]);

  const makeBackup = async () => {
    setBusy('backup');
    setError(null);
    setBackupCheck(null);
    try {
      const result = await client.createBackup();
      setBackupRun(result);
      await loadBackups();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось создать копию');
    } finally {
      setBusy(null);
    }
  };

  const checkBackup = async (name?: string) => {
    setBusy('verify');
    setError(null);
    try {
      setBackupCheck(await client.verifyBackup(name));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось проверить восстановление');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Дашборд прослушиваний (D1) грузится по входу на вкладку и при смене окна:
   * тянуть его при каждом обновлении диагностики незачем — это отдельный вопрос
   * «что слушают», а не «жив ли сервер».
   */
  const loadPlays = useCallback(async (days = playsDays) => {
    setBusy('plays');
    try {
      setPlays(await client.dashboard(days));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось получить статистику прослушиваний');
      setPlays(null);
    } finally {
      setBusy(null);
    }
  }, [client, playsDays]);

  useEffect(() => {
    if (connected && tab === 'plays' && plays === null) void loadPlays();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, tab]);

  const loadAudit = useCallback(async (action = auditFilter) => {
    setBusy('audit');
    try {
      setAudit(await client.audit({ limit: 50, action: action || undefined }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось прочитать журнал');
      setAudit(null);
    } finally {
      setBusy(null);
    }
  }, [client, auditFilter]);

  useEffect(() => {
    if (connected && tab === 'audit' && audit === null) void loadAudit();
    // журнал обновляется при входе на вкладку и по кнопке, а не на каждый рендер
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, tab]);

  const revoke = async (id: string) => {
    setBusy(id);
    try {
      await client.revokeShare(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отозвать');
    } finally {
      setBusy(null);
    }
  };

  const rotate = async (id: string) => {
    setBusy(id);
    try {
      const next = await client.rotateShare(id);
      await refresh();
      if (navigator.clipboard) await navigator.clipboard.writeText(next.url).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось перевыпустить');
    } finally {
      setBusy(null);
    }
  };

  const disk = diskState(health?.diskFreeMb);

  return (
    <div className="shell">
      <header className="brand">
        <span className="mark" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M5 15V9l4 3-4 3z" />
            <path d="M11 18V6l7 6-7 6z" />
          </svg>
        </span>
        <div>
          <div className="brand__name">Vision Server</div>
          <div className="brand__sub">запуск, диагностика и управление библиотекой</div>
        </div>
      </header>

      {/* --- подключение --- */}
      {!connected && (
        <section className="card">
          <div className="card__head">
            <h2>Где сервер</h2>
            {health && <span className="badge badge--ok">отвечает · v{health.version}</span>}
          </div>

          <label className="field">
            <span>Адрес</span>
            <input
              value={base}
              onChange={(event) => setBase(event.target.value)}
              placeholder="192.168.1.10:4000"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <p className="hint">
            {baseHint(base) ?? 'Пусто — сервер на этом же устройстве (панель открыта им самим).'}
            {base ? ` Панель: ${adminUrl(normalizeBase(base))}` : ''}
          </p>

          <div className="row">
            <button type="button" className="btn btn--small" onClick={() => void connect()} disabled={busy === 'connect'}>
              {busy === 'connect' ? 'Проверяю…' : 'Проверить связь'}
            </button>
            <button type="button" className="btn btn--small btn--ghost" onClick={useThisMachine}>
              Сервер на этом устройстве
            </button>
          </div>

          {health && (
            <>
              <label className="field">
                <span>Пароль владельца</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="как в приложении"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && password) void login();
                  }}
                />
              </label>
              <button
                type="button"
                className="btn btn--primary btn--block"
                onClick={() => void login()}
                disabled={!password || busy === 'login'}
              >
                {busy === 'login' ? 'Вхожу…' : 'Войти в панель'}
              </button>
              <p className="hint">
                Платформа сервера: {health.runtime.platform}/{health.runtime.arch}, Node {health.runtime.node}
                {health.runtime.termux ? ', Termux на Android' : ''}.
              </p>
            </>
          )}

          {error && <p className="error">{error}</p>}
        </section>
      )}

      {/* --- панель --- */}
      {connected && (
        <>
          <section className="card">
            <div className="card__head">
              <div>
                <h2>Состояние</h2>
                <p className="muted">
                  {health ? `v${health.version} · ${health.storage.mode} · ${health.storage.deviceId}` : 'нет данных'}
                </p>
              </div>
              <div className="row">
                <span className={`badge ${isReady(checks) ? 'badge--ok' : 'badge--warn'}`}>
                  {isReady(checks) ? 'готов к работе' : 'есть замечания'}
                </span>
                <button
                  type="button"
                  className="btn btn--small btn--ghost"
                  onClick={() => void refresh()}
                  disabled={busy === 'refresh'}
                >
                  {busy === 'refresh' ? '…' : 'Обновить'}
                </button>
                <button type="button" className="btn btn--small btn--ghost" onClick={logout}>
                  Выйти
                </button>
              </div>
            </div>

            <div className="grid">
              <div className="stat">
                <span className="stat__value">{stats?.tracks ?? health?.tracks ?? 0}</span>
                <span className="stat__label">треков</span>
              </div>
              <div className="stat">
                <span className="stat__value">{humanBytes(stats?.bytes)}</span>
                <span className="stat__label">занято файлами</span>
              </div>
              <div className="stat">
                <span className="stat__value">{stats?.plays ?? 0}</span>
                <span className="stat__label">прослушиваний</span>
              </div>
              <div className="stat">
                <span className="stat__value">{stats?.playlists ?? 0}</span>
                <span className="stat__label">плейлистов</span>
              </div>
              <div className="stat">
                <span className="stat__value">{tracker?.seeds ?? health?.tracker.seeds ?? 0}</span>
                <span className="stat__label">устройств раздают файлы</span>
              </div>
              <div className="stat">
                <span className="stat__value">{disk.level === 'ok' ? '✓' : '!'}</span>
                <span className="stat__label">{disk.text}</span>
              </div>
            </div>

            <div className="tabs" role="tablist">
              {(
                [
                  ['overview', 'Диагностика'],
                  ['plays', 'Прослушивания'],
                  ['shares', `Ссылки${shares.length ? ` (${shares.length})` : ''}`],
                  ['library', 'Библиотека'],
                  ['backups', 'Копии'],
                  ['audit', 'Журнал'],
                ] as [Tab, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  className={`tab${tab === id ? ' is-active' : ''}`}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === 'overview' && (
              <div style={{ display: 'grid', gap: 8 }}>
                {checks.map((check) => (
                  <div key={check.title} className="check">
                    <span className={`check__dot check__dot--${check.level}`} />
                    <div>
                      <div className="check__title">{check.title}</div>
                      <div className="check__detail">{check.detail}</div>
                    </div>
                  </div>
                ))}
                <p className="hint">
                  Те же проверки, что в <span className="code">docs/RUNBOOK.md</span>, но словами. Если диск
                  заполняется — удалите офлайн-копии на телефоне или старые треки.
                </p>
              </div>
            )}

            {tab === 'plays' && (
              <div style={{ display: 'grid', gap: 10 }}>
                <div className="row row--between">
                  <div className="row" style={{ gap: 6 }}>
                    {[7, 30, 90].map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={`btn btn--small${playsDays === value ? '' : ' btn--ghost'}`}
                        onClick={() => {
                          setPlaysDays(value);
                          setPlays(null);
                          void loadPlays(value);
                        }}
                      >
                        {value} дн.
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn btn--small btn--ghost"
                    disabled={busy === 'plays'}
                    onClick={() => void loadPlays()}
                  >
                    {busy === 'plays' ? 'Считаю…' : 'Обновить'}
                  </button>
                </div>

                {plays === null && <p className="muted">Считаю прослушивания…</p>}

                {plays !== null && plays.totals.plays === 0 && (
                  <p className="muted">{plays.hint ?? 'Прослушиваний пока нет.'}</p>
                )}

                {plays !== null && plays.totals.plays > 0 && (
                  <>
                    <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
                      <span className="badge badge--ok">{plays.totals.plays} прослушиваний</span>
                      <span className="badge">{plays.totals.completed} до конца</span>
                      <span className="badge">{plays.totals.tracks} треков</span>
                      <span className="badge">{plays.sources.owner} своих · {plays.sources.share} по ссылкам</span>
                    </div>

                    <div className="plays-chart" aria-label={`Прослушивания за ${plays.days} дней`}>
                      {playsChart(plays.byDay).map((item) => (
                        <div
                          key={item.day}
                          className="plays-chart__col"
                          title={`${item.day}: ${item.plays}`}
                        >
                          <i
                            className={item.shared ? 'is-shared' : undefined}
                            style={{ height: `${item.height}%` }}
                          />
                        </div>
                      ))}
                    </div>
                    <span className="muted">
                      {plays.byDay[0]?.day.slice(5)} — {plays.byDay[plays.byDay.length - 1]?.day.slice(5)},
                      серые столбики — прослушивания по гостевым ссылкам
                    </span>

                    {plays.topTracks.map((track, index) => (
                      <div key={track.id} className="link-row">
                        <div className="row row--between">
                          <span className="link-row__title">
                            {index + 1}. {track.deleted ? 'трек удалён из библиотеки' : track.title}
                          </span>
                          <span className="badge">{track.plays}</span>
                        </div>
                        <span className="muted">
                          {track.artist ? `${track.artist} · ` : ''}
                          {track.completed ? `${track.completed} до конца` : 'не дослушивали'}
                        </span>
                      </div>
                    ))}

                    {plays.listeners.length > 0 && (
                      <p className="hint">
                        Слушали с {plays.listeners.length} разных адресов — отпечатки{' '}
                        {plays.listeners.slice(0, 3).map((listener) => listener.id).join(', ')}
                        {plays.listeners.length > 3 ? '…' : ''}. Сырые адреса не хранятся, город по
                        отпечатку не восстановить: видно «из одного места или из десяти», а не кто именно.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {tab === 'shares' && (
              <div style={{ display: 'grid', gap: 8 }}>
                {shares.length === 0 && <p className="muted">Ссылок нет. Создать можно в приложении: меню трека → «Поделиться ссылкой».</p>}
                {shares.map((share) => {
                  const dead = Boolean(share.revokedAt) || Boolean(share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now());
                  return (
                    <div key={share.id} className="link-row">
                      <div className="row row--between">
                        <span className="link-row__title">
                          {share.title || 'без подписи'} · {share.targetKind === 'track' ? 'трек' : 'плейлист'}
                        </span>
                        {dead ? (
                          <span className="badge">не действует</span>
                        ) : (
                          <span className="badge badge--ok">{expiry(share.expiresAt)}</span>
                        )}
                      </div>
                      <span className="link-row__meta">
                        открытий {share.plays}
                        {share.maxPlays ? `/${share.maxPlays}` : ''} · {ago(share.stats?.lastHitAt ?? null)}
                        {share.comments ? ` · комментариев ${share.comments}` : ''}
                      </span>
                      {!dead && (
                        <div className="row">
                          <button
                            type="button"
                            className="btn btn--small btn--ghost"
                            disabled={busy === share.id}
                            onClick={() => void rotate(share.id)}
                          >
                            Перевыпустить
                          </button>
                          <button
                            type="button"
                            className="btn btn--small btn--ghost"
                            disabled={busy === share.id}
                            onClick={() => void revoke(share.id)}
                          >
                            Отозвать
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                <p className="hint">Перевыпуск копирует новую ссылку в буфер — старую больше никто не откроет.</p>
              </div>
            )}

            {tab === 'library' && (
              <div style={{ display: 'grid', gap: 8 }}>
                {(stats?.genres?.length ?? 0) > 0 && (
                  <div className="row" style={{ gap: 6 }}>
                    {stats?.genres.slice(0, 8).map((genre) => (
                      <span key={genre.genre} className="badge">
                        {genre.genre} · {genre.count}
                      </span>
                    ))}
                  </div>
                )}
                <p className="muted">
                  Загрузка, плейлисты и плеер живут в основном приложении Vision Audio. Здесь — только то,
                  что нужно для эксплуатации: сколько занято, что раздаётся и какие ссылки открывали.
                </p>
                <div className="row">
                  <a className="btn btn--small" href={`${normalizeBase(base)}/`} target="_blank" rel="noreferrer">
                    Открыть библиотеку
                  </a>
                  <a className="btn btn--small btn--ghost" href={`${normalizeBase(base)}/api/openapi.json`} target="_blank" rel="noreferrer">
                    OpenAPI
                  </a>
                  <a className="btn btn--small btn--ghost" href={`${normalizeBase(base)}/metrics`} target="_blank" rel="noreferrer">
                    Метрики
                  </a>
                </div>
                <p className="hint code">
                  {tracker
                    ? `файлов ${tracker.blobs}, без источника ${tracker.noSource}, устройств ${tracker.devices}`
                    : 'трекер реплик недоступен'}
                </p>
              </div>
            )}

            {tab === 'backups' && (
              <div style={{ display: 'grid', gap: 10 }}>
                <div className="row row--between">
                  <span className="muted">
                    {backups
                      ? `${backups.count} из ${backups.keep} · ${humanBytes(backups.totalBytes)}`
                      : 'Читаю статус…'}
                  </span>
                  <div className="row" style={{ gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn--small btn--ghost"
                      disabled={busy === 'verify' || !backups?.last}
                      onClick={() => void checkBackup()}
                    >
                      {busy === 'verify' ? 'Проверяю…' : 'Проверить восстановление'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={busy === 'backup'}
                      onClick={() => void makeBackup()}
                    >
                      {busy === 'backup' ? 'Копирую…' : 'Сделать копию'}
                    </button>
                  </div>
                </div>

                {backups && (
                  <div className="check">
                    <span className={`check__dot check__dot--${backups.level === 'ok' ? 'ok' : 'warn'}`} />
                    <div>
                      <div className="check__title">
                        {backups.last
                          ? `Последняя копия: ${ago(backups.last.createdAt)}, ${humanBytes(backups.last.bytes)}`
                          : 'Резервных копий ещё нет'}
                      </div>
                      <div className="check__detail">
                        {backups.hint ?? `Хранится до ${backups.keep} копий. Расписание: ${
                          backups.schedule.running ? `каждые ${backups.schedule.hours} ч` : 'выключено (BACKUP_EVERY_HOURS=0)'
                        }.`}
                      </div>
                    </div>
                  </div>
                )}

                {backupRun && (
                  <div className="check">
                    <span className={`check__dot check__dot--${backupRun.ok ? 'ok' : 'fail'}`} />
                    <div>
                      <div className="check__title">
                        {backupRun.ok ? 'Копия создана и проверена' : 'Копия создана, проверка не прошла'}
                      </div>
                      <div className="check__detail">
                        {backupRun.name} · треков {backupRun.verification.counts.tracks ?? 0},
                        файлов проверено {backupRun.verification.checkedFiles}
                        {backupRun.pruned.length ? ` · удалено старых ${backupRun.pruned.length}` : ''}
                        {backupRun.verification.problems.length
                          ? ` · ${backupRun.verification.problems.join('; ')}`
                          : ''}
                      </div>
                    </div>
                  </div>
                )}

                {backupCheck && (
                  <div className="check">
                    <span className={`check__dot check__dot--${backupCheck.ok ? 'ok' : 'fail'}`} />
                    <div>
                      <div className="check__title">
                        {backupCheck.ok ? 'Из архива можно восстановиться' : 'Архив не восстановить'}
                      </div>
                      <div className="check__detail">
                        {backupCheck.archive.split('/').pop()} · треков {backupCheck.counts.tracks ?? 0},
                        файлов {backupCheck.checkedFiles}
                        {backupCheck.problems.length ? ` · ${backupCheck.problems.join('; ')}` : ''}
                      </div>
                    </div>
                  </div>
                )}

                {(backups?.backups ?? []).map((item) => (
                  <div key={item.name} className="link-row">
                    <div className="row row--between">
                      <span className="link-row__title">{item.name}</span>
                      <span className="badge">{humanBytes(item.bytes)}</span>
                    </div>
                    <div className="row row--between">
                      <span className="muted">{ago(item.createdAt)}</span>
                      <button
                        type="button"
                        className="btn btn--small btn--ghost"
                        disabled={busy === 'verify'}
                        onClick={() => void checkBackup(item.name)}
                      >
                        Проверить
                      </button>
                    </div>
                  </div>
                ))}

                <p className="hint">
                  Копия — снимок живой базы (VACUUM INTO) плюс медиа и обложки. Проверка открывает
                  снимок и сверяет целостность, число треков и наличие файлов: архив, который не
                  проверили, — это надежда, а не резервная копия. Каталог:{' '}
                  <span className="code">{backups?.dir ?? '…'}</span>
                </p>
              </div>
            )}

            {tab === 'audit' && (
              <div style={{ display: 'grid', gap: 8 }}>
                <div className="row row--between">
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {AUDIT_FILTERS.map((filter) => (
                      <button
                        key={filter.value || 'all'}
                        type="button"
                        className={`btn btn--small${auditFilter === filter.value ? '' : ' btn--ghost'}`}
                        onClick={() => {
                          setAuditFilter(filter.value);
                          void loadAudit(filter.value);
                        }}
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn btn--small btn--ghost"
                    disabled={busy === 'audit'}
                    onClick={() => void loadAudit()}
                  >
                    {busy === 'audit' ? 'Читаю…' : 'Обновить'}
                  </button>
                </div>

                {audit === null && <p className="muted">Читаю журнал…</p>}
                {audit !== null && audit.entries.length === 0 && (
                  <p className="muted">
                    Пока пусто. Журнал заполняется сам: вход, загрузка и удаление треков, правка
                    плейлистов, ссылки и комментарии гостей.
                  </p>
                )}
                {audit?.entries.map((entry) => (
                  <div key={entry.id} className="link-row">
                    <div className="row row--between">
                      <span className="link-row__title">{entry.label}</span>
                      <span className="badge">{auditClock(entry.at)}</span>
                    </div>
                    <span className="muted">
                      {entry.actor} · {entry.action}
                      {entry.ipHash ? ` · гость ${entry.ipHash.slice(0, 8)}` : ''}
                      {entry.requestId ? ` · запрос ${entry.requestId}` : ''}
                    </span>
                  </div>
                ))}
                {audit !== null && audit.entries.length > 0 && (
                  <p className="hint">
                    Показаны последние {audit.entries.length} из {audit.total}. Журнал хранится{' '}
                    {audit.retentionDays} дн.; адреса гостей — только необратимые хеши, токены ссылок
                    не записываются никогда.
                    {audit.entries[0]?.shareId && ` По ссылке ${audit.entries[0].shareId.slice(0, 8)}… можно фильтровать через API.`}
                  </p>
                )}
              </div>
            )}

            {error && <p className="error">{error}</p>}
          </section>

          <section className="card">
            <h2>Как поставить сервер</h2>
            <p className="muted">
              Windows: запустите приложение — «сервер на этом ПК» поднимает локальный API и открывает
              библиотеку. Android: сервер обычно живёт на телефоне в Termux, а панель — в этом приложении
              (адрес из Wi-Fi, например <span className="code">192.168.1.10:4000</span>).
            </p>
            <p className="hint">
              Данные сервера — папка <span className="code">DATA_DIR</span> (по умолчанию{' '}
              <span className="code">./data</span>): база, файлы, обложки. Скопировали папку — перенесли всё.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
