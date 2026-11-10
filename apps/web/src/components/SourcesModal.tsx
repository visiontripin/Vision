import { useCallback, useEffect, useState } from 'react';
import type { BlobSeed, BlobState, Track } from '@vision/shared';
import { formatBytes } from '@vision/shared';
import { api, IS_LOCAL_MODE } from '../api';
import { Cover, Icon, useToast } from '../ui';

/**
 * «Где лежит файл»: реестр реплик по одному треку.
 *
 * Показываем устройства-сиды (кто отдаёт), копии без раздачи (браузер/телефон) и
 * даём две операции: забрать копию на этот узел и удалить свою реплику.
 * В локальном режиме (GitHub Pages) трекера нет — модалка просто не открывается.
 */

const KIND_LABEL: Record<string, string> = {
  origin: 'этот сервер (origin)',
  node: 'Termux / ПК',
  desktop: 'десктоп',
  mobile: 'телефон',
  browser: 'браузер',
};

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'только что';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

export function SourcesModal({ track, onClose, onChanged }: {
  track: Track;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { push } = useToast();
  const [state, setState] = useState<BlobState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'replicate' | 'remove' | null>(null);
  const hash = track.checksum ?? null;

  const load = useCallback(async () => {
    if (!hash) {
      setLoading(false);
      return;
    }
    try {
      const next = await api.blob(hash);
      setState(next);
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось получить источники', 'error');
    } finally {
      setLoading(false);
    }
  }, [hash, push]);

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

  if (IS_LOCAL_MODE) return null;

  const replicate = async () => {
    if (!hash || busy) return;
    setBusy('replicate');
    try {
      const result = await api.replicateBlob(hash);
      push(
        result.already
          ? 'Копия уже была на этом узле'
          : `Копия скачана${result.bytes ? `: ${formatBytes(result.bytes)}` : ''}`
      );
      await load();
      onChanged?.();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось забрать файл', 'error');
    } finally {
      setBusy(null);
    }
  };

  const removeReplica = async () => {
    if (!hash || busy) return;
    if (!window.confirm('Удалить реплику с этого устройства? Файл останется у других сидов.')) return;
    setBusy('remove');
    try {
      await api.removeReplica(hash);
      push('Реплика удалена');
      await load();
      onChanged?.();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось удалить реплику', 'error');
    } finally {
      setBusy(null);
    }
  };

  const seeds: BlobSeed[] = state?.seeds ?? [];
  const servable = seeds.filter((seed) => seed.servable);
  const replicas = seeds.filter((seed) => !seed.servable);
  const canReplicate = Boolean(hash) && !state?.local && servable.length > 0;
  const canRemove = Boolean(state?.seeded);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Источники файла ${track.title}`}>
      <div className="modal__backdrop" onClick={() => !busy && onClose()} />
      <div className="modal__card">
        <header className="modal__head">
          <div className="sources__title">
            <Cover track={track} size={40} />
            <div>
              <h2>{track.title}</h2>
              <p>
                {track.artist} · {formatBytes(track.size)}
                {hash ? ` · ${hash.slice(0, 10)}…` : ' · sha256 неизвестен'}
              </p>
            </div>
          </div>
          <button type="button" className="iconbtn" aria-label="Закрыть" onClick={onClose} disabled={Boolean(busy)}>
            <Icon name="close" size={20} />
          </button>
        </header>

        {!hash && (
          <p className="muted">
            У трека нет контрольной суммы — он загружен до появления трекера и ни с кем не делится.
          </p>
        )}

        {hash && loading && <p className="muted">Спрашиваю трекер…</p>}

        {hash && !loading && state && (
          <>
            <dl className="facts sources__facts">
              <div>
                <dt>Файл на этом устройстве</dt>
                <dd>{state.local ? (state.seeded ? 'реплика' : 'оригинал') : 'нет'}</dd>
              </div>
              <div>
                <dt>Раздают</dt>
                <dd>{servable.length}</dd>
              </div>
              <div>
                <dt>Копии без раздачи</dt>
                <dd>{replicas.length}</dd>
              </div>
              <div>
                <dt>Размер</dt>
                <dd>{formatBytes(state.blob.bytes || track.size)}</dd>
              </div>
            </dl>

            {seeds.length === 0 ? (
              <p className="muted">
                Ни одно устройство сейчас не раздаёт этот файл. Пока он не появится у сида,
                трек будет помечен «нет источника».
              </p>
            ) : (
              <ul className="sources__list">
                {seeds.map((seed) => (
                  <li key={seed.deviceId} className="sources__row">
                    <span className={`sources__dot${seed.servable ? ' is-online' : ''}`} title={seed.servable ? 'раздаёт' : 'только копия'} />
                    <span className="sources__device">
                      {seed.deviceId === state.deviceId ? 'это устройство' : KIND_LABEL[seed.kind] || seed.kind}
                      <em>{seed.deviceId}</em>
                    </span>
                    <span className="sources__meta">
                      {seed.servable ? 'раздаёт' : 'копия'} · {ago(seed.onlineAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="sources__actions">
              <button
                type="button"
                className="btn btn--small btn--primary"
                disabled={!canReplicate || Boolean(busy)}
                onClick={() => void replicate()}
                title={
                  canReplicate
                    ? 'Скачать файл с живого сида и раздавать его с этого узла'
                    : state.local
                      ? 'Файл уже есть на этом узле'
                      : 'Пока никто не раздаёт файл'
                }
              >
                <Icon name="download" size={15} />
                {busy === 'replicate' ? 'Качаю…' : 'Забрать копию сюда'}
              </button>

              <button
                type="button"
                className="btn btn--small btn--ghost"
                disabled={!canRemove || Boolean(busy)}
                onClick={() => void removeReplica()}
                title={
                  canRemove
                    ? 'Удалить скачанную копию, оригинал в медиатеке не тронется'
                    : 'На этом узле нет реплики'
                }
              >
                <Icon name="trash" size={15} />
                {busy === 'remove' ? 'Удаляю…' : 'Удалить реплику'}
              </button>
            </div>

            <p className="muted sources__hint">
              Телефон и браузер раздавать файл не могут — они только числятся владельцами копии.
              Скачивание идёт с сервера, Termux или ПК с включённым сидом.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
