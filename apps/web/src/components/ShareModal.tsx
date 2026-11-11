import { useCallback, useEffect, useState } from 'react';
import type { Share, ShareComment, ShareWithToken } from '@vision/shared';
import { api, IS_LOCAL_MODE } from '../api';
import { Cover, Icon, useToast } from '../ui';
import type { Track } from '@vision/shared';

/**
 * Приватные ссылки на трек/плейлист (Фаза 6, E1).
 *
 * Правила, которые задаёт контракт:
 *  - токен показывается один раз (в БД лежит только sha256) — поэтому после
 *    создания ссылка сразу копируется в буфер и предлагается «Отправить»;
 *  - срок жизни и лимит открытий настраиваются до создания;
 *  - отзыв мгновенный, перевыпуск делает старую ссылку недействительной.
 *
 * Локальный режим (GitHub Pages) ссылок не даёт: там нет сервера, а значит и
 * адреса, который откроется у друга.
 */

const TTL_OPTIONS: { value: string; label: string }[] = [
  { value: '1h', label: '1 час' },
  { value: '24h', label: 'Сутки' },
  { value: '7d', label: '7 дней' },
  { value: '30d', label: '30 дней' },
  { value: 'forever', label: 'Бессрочно' },
];

function ago(iso: string | null): string {
  if (!iso) return 'ещё не открывали';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'только что';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

/** `1:07` — таймкод комментария; часы нужны только длинным трекам. */
function stamp(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function expiresLabel(share: Share): string {
  if (!share.expiresAt) return 'бессрочная';
  const at = new Date(share.expiresAt);
  if (Number.isNaN(at.getTime())) return 'бессрочная';
  return at.getTime() <= Date.now() ? 'истекла' : `до ${at.toLocaleDateString('ru-RU')}`;
}

export function ShareModal({
  target,
  onClose,
}: {
  target: { kind: 'track'; track: Track } | { kind: 'playlist'; id: string; name: string; cover?: Track | null };
  onClose: () => void;
}) {
  const { push } = useToast();
  const [list, setList] = useState<Share[] | null>(null);
  const [ttl, setTtl] = useState('7d');
  const [maxPlays, setMaxPlays] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<'create' | string | null>(null);
  const [fresh, setFresh] = useState<ShareWithToken | null>(null);
  /** лента комментариев выбранной ссылки: у каждой ссылки своя */
  const [openComments, setOpenComments] = useState<string | null>(null);
  const [feed, setFeed] = useState<ShareComment[] | null>(null);
  const [draft, setDraft] = useState({ at: '', author: '', body: '' });

  const targetKind = target.kind;
  const targetId = target.kind === 'track' ? target.track.id : target.id;

  const load = useCallback(async () => {
    try {
      setList(await api.shares({ targetKind, targetId, includeRevoked: true }));
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось получить ссылки', 'error');
      setList([]);
    }
  }, [targetKind, targetId, push]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      push('Ссылка скопирована');
    } catch {
      push('Не удалось скопировать — выделите ссылку вручную', 'error');
    }
  };

  const create = async () => {
    if (busy) return;
    setBusy('create');
    try {
      const created = await api.createShare({
        targetKind,
        targetId,
        title: label.trim() || null,
        ttl,
        maxPlays: maxPlays.trim() ? Number(maxPlays) : null,
      });
      setFresh(created);
      setLabel('');
      await load();
      void copy(created.url);
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось создать ссылку', 'error');
    } finally {
      setBusy(null);
    }
  };

  const loadFeed = useCallback(async (shareId: string) => {
    setFeed(null);
    try {
      const result = await api.shareComments(shareId, target.kind === 'track' ? targetId : undefined);
      setFeed(result.comments);
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось получить комментарии', 'error');
      setFeed([]);
    }
  }, [push, target.kind, targetId]);

  const toggleFeed = (share: Share) => {
    if (openComments === share.id) {
      setOpenComments(null);
      setFeed(null);
      return;
    }
    setOpenComments(share.id);
    void loadFeed(share.id);
  };

  /**
   * Владелец тоже может отметить секунду — комментарий сразу увидят гости.
   * Секунда по умолчанию не ноль: у трека берём середину, у плейлиста просим ввести.
   */
  const addComment = async (share: Share) => {
    if (busy || !draft.body.trim()) return;
    setBusy(share.id);
    try {
      const created = await api.addShareComment(share.id, {
        trackId: targetId,
        at: Number(draft.at) || 0,
        author: draft.author.trim() || 'Владелец',
        body: draft.body.trim(),
      });
      setFeed((current) => [...(current ?? []), created].sort((a, b) => a.at - b.at));
      setDraft((current) => ({ ...current, body: '' }));
      await load();
      push(`Комментарий на ${stamp(created.at)} добавлен`);
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось добавить комментарий', 'error');
    } finally {
      setBusy(null);
    }
  };

  const dropComment = async (share: Share, comment: ShareComment) => {
    if (busy) return;
    setBusy(comment.id);
    try {
      await api.deleteShareComment(share.id, comment.id);
      setFeed((current) => (current ?? []).filter((item) => item.id !== comment.id));
      await load();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось удалить комментарий', 'error');
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (share: Share) => {
    if (busy) return;
    setBusy(share.id);
    try {
      await api.deleteShare(share.id);
      if (fresh?.id === share.id) setFresh(null);
      push('Ссылка отозвана');
      await load();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось отозвать ссылку', 'error');
    } finally {
      setBusy(null);
    }
  };

  const rotate = async (share: Share) => {
    if (busy) return;
    setBusy(share.id);
    try {
      const next = await api.rotateShare(share.id);
      setFresh(next);
      await load();
      void copy(next.url);
      push('Старая ссылка больше не работает');
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось перевыпустить ссылку', 'error');
    } finally {
      setBusy(null);
    }
  };

  const title = target.kind === 'track' ? target.track.title : target.name;
  const cover = target.kind === 'track' ? target.track : target.cover ?? null;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Ссылка на ${title}`}>
      <div className="modal__backdrop" onClick={() => !busy && onClose()} />
      <div className="modal__card">
        <header className="modal__head">
          <div className="sources__title">
            {cover ? (
              <Cover track={cover} size={40} />
            ) : (
              <span className="brand__mark" aria-hidden="true">
                <Icon name="disc" size={18} />
              </span>
            )}
            <div>
              <h2>{title}</h2>
              <p>
                {target.kind === 'track' ? 'Приватная ссылка на трек' : 'Приватная ссылка на плейлист'}
                {' · '}без аккаунта, с отзывом
              </p>
            </div>
          </div>
          <button type="button" className="iconbtn" aria-label="Закрыть" onClick={onClose} disabled={Boolean(busy)}>
            <Icon name="close" size={20} />
          </button>
        </header>

        {IS_LOCAL_MODE ? (
          <p className="muted">
            Ссылки живут на сервере: он отдаёт гостю страницу и файл. В локальном режиме
            (GitHub Pages) сервера нет — запустите <code>npm start</code> и поделитесь адресом оттуда.
          </p>
        ) : (
          <>
            <div className="share__form">
              <label className="field">
                <span>Подпись для себя</span>
                <input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="например, для Димы"
                  maxLength={120}
                />
              </label>
              <label className="field">
                <span>Срок жизни</span>
                <select value={ttl} onChange={(event) => setTtl(event.target.value)}>
                  {TTL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Лимит открытий</span>
                <input
                  value={maxPlays}
                  onChange={(event) => setMaxPlays(event.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="без лимита"
                  inputMode="numeric"
                />
              </label>
            </div>

            <button
              type="button"
              className="btn btn--primary btn--block"
              onClick={() => void create()}
              disabled={busy === 'create'}
            >
              <Icon name="external" size={16} />
              {busy === 'create' ? 'Создаю…' : 'Создать ссылку'}
            </button>

            {fresh && (
              <div className="share__fresh" role="status">
                <div>
                  <strong>Ссылка готова — сохраните её сейчас</strong>
                  <p>Сервер хранит только хеш токена и показать адрес повторно не сможет.</p>
                </div>
                <div className="share__url">
                  <input readOnly value={fresh.url} aria-label="Ссылка" onFocus={(event) => event.currentTarget.select()} />
                  <button type="button" className="btn btn--small" onClick={() => void copy(fresh.url)}>
                    Копировать
                  </button>
                </div>
                <div className="share__freshActions">
                  <a className="btn btn--small btn--ghost" href={fresh.url} target="_blank" rel="noreferrer">
                    Открыть
                  </a>
                  <button
                    type="button"
                    className="btn btn--small btn--ghost"
                    onClick={() => {
                      const text = `${title} — Vision Audio\n${fresh.url}`;
                      if (navigator.share) void navigator.share({ title, text, url: fresh.url }).catch(() => {});
                      else void copy(text);
                    }}
                  >
                    Отправить
                  </button>
                </div>
              </div>
            )}

            <div className="share__list">
              <div className="menu__label">Мои ссылки</div>
              {list === null && <p className="muted">Спрашиваю сервер…</p>}
              {list !== null && list.length === 0 && (
                <p className="muted">Ссылок пока нет. Созданная откроется у любого, кому вы её отправите.</p>
              )}
              {list?.map((share) => {
                const expired = Boolean(share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now());
                const dead = Boolean(share.revokedAt) || expired;
                const hits = share.stats?.hits ?? {};
                return (
                  <div key={share.id} className={`share__row${dead ? ' is-dead' : ''}`}>
                    <div className="share__meta">
                      <strong>{share.title || 'без подписи'}</strong>
                      <span>
                        {dead ? (share.revokedAt ? 'отозвана' : 'истекла') : expiresLabel(share)} · открытий:{' '}
                        {share.plays}
                        {share.maxPlays ? `/${share.maxPlays}` : ''} · {ago(share.lastSeenAt)}
                      </span>
                      {(hits.download || hits.stream) && (
                        <span className="muted">
                          прослушиваний: {hits.stream ?? 0} · скачиваний: {hits.download ?? 0}
                        </span>
                      )}
                    </div>
                    <div className="share__rowActions">
                      <button
                        type="button"
                        className="btn btn--small btn--ghost"
                        onClick={() => toggleFeed(share)}
                        aria-expanded={openComments === share.id}
                        title="Комментарии гостей к секундам"
                      >
                        Комментарии{share.comments ? ` (${share.comments})` : ''}
                      </button>
                      {!dead && (
                        <>
                          <button
                            type="button"
                            className="btn btn--small btn--ghost"
                            onClick={() => void rotate(share)}
                            disabled={Boolean(busy)}
                            title="Выпустить новый токен; старая ссылка сразу перестанет работать"
                          >
                            {busy === share.id ? '…' : 'Перевыпустить'}
                          </button>
                          <button
                            type="button"
                            className="btn btn--small btn--ghost"
                            onClick={() => void revoke(share)}
                            disabled={Boolean(busy)}
                          >
                            Отозвать
                          </button>
                        </>
                      )}
                    </div>

                    {openComments === share.id && (
                      <div className="share__feed">
                        {feed === null && <p className="muted">Читаю комментарии…</p>}
                        {feed !== null && feed.length === 0 && (
                          <p className="muted">
                            Гости ещё ничего не отметили. Комментарий привязывается к секунде —
                            гость видит его под треком и может перемотать тапом.
                          </p>
                        )}
                        {feed?.map((comment) => (
                          <div key={comment.id} className="share__cmt">
                            <span className="share__stamp">{stamp(comment.at)}</span>
                            <strong>{comment.author}</strong>
                            <span className="share__cmtBody">{comment.body}</span>
                            <button
                              type="button"
                              className="share__cmtDel"
                              aria-label="Удалить комментарий"
                              disabled={Boolean(busy)}
                              onClick={() => void dropComment(share, comment)}
                            >
                              ×
                            </button>
                          </div>
                        ))}

                        {target.kind === 'track' && (
                          <div className="share__cmtForm">
                            <input
                              className="share__stampInput"
                              value={draft.at}
                              onChange={(event) => setDraft((d) => ({ ...d, at: event.target.value.replace(/[^\d.]/g, '').slice(0, 7) }))}
                              placeholder="сек"
                              inputMode="decimal"
                              aria-label="Секунда"
                            />
                            <input
                              value={draft.author}
                              onChange={(event) => setDraft((d) => ({ ...d, author: event.target.value.slice(0, 40) }))}
                              placeholder="подпись"
                              aria-label="Подпись автора"
                            />
                            <input
                              className="share__cmtInput"
                              value={draft.body}
                              onChange={(event) => setDraft((d) => ({ ...d, body: event.target.value.slice(0, 600) }))}
                              placeholder="Что сказать на этой секунде?"
                              aria-label="Комментарий"
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') void addComment(share);
                              }}
                            />
                            <button
                              type="button"
                              className="btn btn--small"
                              disabled={Boolean(busy) || !draft.body.trim()}
                              onClick={() => void addComment(share)}
                            >
                              Добавить
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="muted sources__hint">
              Гость видит одну страницу с плеером и кнопкой «Скачать», без доступа к библиотеке.
              Ссылки закрыты от поисковиков ({'noindex'}), а статистика открытий видна только вам.
              Комментарии привязаны к секунде и к конкретной ссылке: в другой ссылке их не видно.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
