import { useCallback, useEffect, useState } from 'react';
import type { Share, ShareWithToken } from '@vision/shared';
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
                    {!dead && (
                      <div className="share__rowActions">
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
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="muted sources__hint">
              Гость видит одну страницу с плеером и кнопкой «Скачать», без доступа к библиотеке.
              Ссылки закрыты от поисковиков ({'noindex'}), а статистика открытий видна только вам.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
