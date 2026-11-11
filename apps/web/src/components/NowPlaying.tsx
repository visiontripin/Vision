import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatBytes, formatDuration } from '@vision/shared';
import { api, IS_LOCAL_MODE } from '../api';
import { ensureMedia, getDownloadUrl, getMedia, invalidateMedia } from '../media';
import {
  cacheTrack, isTrackCached, offlineSupported, removeTrackCopy, useOffline,
} from '../offline';
import { announceReplica, withdrawReplica } from '../seeds';
import { useLibrary } from '../state/library';
import { usePlayer } from '../state/player';
import { Cover, Icon, useToast, Waveform, hashHue } from '../ui';
import { ShareModal } from './ShareModal';

/**
 * Полноэкранный плеер (Фаза 6, UX): нажатие на нижнюю панель разворачивает экран
 * с обложкой-фоном, большой волной, перемоткой пальцем/кликом и транспортом.
 *
 * Рендерится **порталом в `body`** и это не стилистическая прихоть: панель плеера
 * имеет `backdrop-filter: blur(...)`, а свойство `backdrop-filter` (как и
 * `filter`/`transform`) делает элемент containing block для `position: fixed`.
 * Плеер, вложенный в панель, «приклеивался» к ней и разворачивался на высоту
 * нижней панели — на телефоне это выглядело как обрезанный снизу экран.
 *
 * Закрывается крестиком, `Esc` и свайпом вниз — как привычные мобильные плееры.
 * Состояние не дублируется: всё берётся из `usePlayer`, поэтому свёрнутая панель
 * и полный экран всегда показывают одно и то же.
 */
export function NowPlaying({ open, onClose }: { open: boolean; onClose: () => void }) {
  const player = usePlayer();
  const { patchTrack } = useLibrary();
  const { push } = useToast();
  const [downloading, setDownloading] = useState<number | 'start' | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const touchStart = useRef<number | null>(null);

  useOffline();

  const current = player.current;

  useEffect(() => {
    if (!open) {
      setShareOpen(false);
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // пока полный экран открыт, страница под ним не ездит
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open || !current) return null;

  const media = getMedia(current.id);
  const duration = player.duration || current.duration || 0;
  const progress = duration > 0 ? Math.min(1, player.position / duration) : 0;
  const hue = hashHue(current.title + current.id);
  const cached = isTrackCached(current);
  const canOffline = offlineSupported() && !IS_LOCAL_MODE;

  const toggleLike = async () => {
    try {
      const updated = await api.setLiked(current.id, !current.liked);
      patchTrack(current.id, { liked: updated.liked });
      player.replaceTrack(updated);
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось обновить лайк', 'error');
    }
  };

  const toggleOffline = async () => {
    if (downloading !== null) return;
    if (cached) {
      await removeTrackCopy(current);
      void withdrawReplica(current);
      push('Офлайн-копия удалена');
      return;
    }
    try {
      setDownloading('start');
      await ensureMedia([current.id]);
      const url = getDownloadUrl(current.id);
      if (!url) throw new Error('Ссылка на файл ещё не готова');
      const entry = await cacheTrack(current, url, {
        onProgress: (ratio) => setDownloading(ratio === null ? 'start' : Math.round(ratio * 100)),
      });
      void announceReplica(current);
      push(`Копия готова: ${formatBytes(entry.bytes)}`);
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось сохранить копию', 'error');
    } finally {
      setDownloading(null);
    }
  };

  const refreshLink = async () => {
    invalidateMedia(current.id);
    await ensureMedia([current.id]);
    push('Ссылка обновлена');
  };

  const content = (
    <div className="np" role="dialog" aria-modal="true" aria-label={`Плеер: ${current.title}`}>
      <div
        className="np__backdrop"
        aria-hidden="true"
        style={{
          background: media?.cover
            ? `linear-gradient(180deg, rgba(7,7,10,.55), rgba(7,7,10,.92)), url("${media.cover}") center/cover`
            : `radial-gradient(900px 600px at 50% 0%, hsl(${hue} 60% 22%), #07070a 70%)`,
        }}
      />

      <div
        className="np__sheet"
        onTouchStart={(event) => {
          touchStart.current = event.touches[0]?.clientY ?? null;
        }}
        onTouchEnd={(event) => {
          const start = touchStart.current;
          const end = event.changedTouches[0]?.clientY ?? null;
          touchStart.current = null;
          if (start !== null && end !== null && end - start > 90) onClose();
        }}
      >
        <header className="np__top">
          <button type="button" className="np__round" aria-label="Свернуть плеер" onClick={onClose}>
            <Icon name="chevronDown" size={20} />
          </button>
          <span className="np__label">Сейчас играет</span>
          <div className="np__topActions">
            <button
              type="button"
              className="np__round"
              aria-label={cached ? 'Удалить офлайн-копию' : 'Скачать офлайн'}
              onClick={() => void toggleOffline()}
              disabled={!canOffline || downloading !== null}
              title={canOffline ? undefined : 'Офлайн-копии недоступны в этом режиме'}
            >
              {downloading !== null ? (
                <span className="np__percent">{downloading === 'start' ? '…' : `${downloading}%`}</span>
              ) : (
                <Icon name={cached ? 'check' : 'download'} size={18} />
              )}
            </button>
            <button
              type="button"
              className="np__round"
              aria-label="Очередь воспроизведения"
              onClick={() => {
                // очередь — отдельная панель поверх списка: полный экран уступает ей место
                onClose();
                player.setQueueOpen(true);
              }}
            >
              <Icon name="queue" size={18} />
            </button>
            <button type="button" className="np__round" aria-label="Поделиться ссылкой" onClick={() => setShareOpen(true)}>
              <Icon name="share" size={18} />
            </button>
          </div>
        </header>

        <div className="np__cover">
          <Cover track={current} size={Math.min(320, 300)} />
        </div>

        <div className="np__meta">
          <h1 className="np__title">{current.title}</h1>
          <p className="np__artist">
            {current.artist}
            {current.album ? ` — ${current.album}` : ''}
          </p>
          <div className="np__badges">
            {cached && <span className="pill">офлайн</span>}
            {current.genre && <span className="pill">{current.genre}</span>}
            {current.available === false && <span className="pill pill--warn">нет источника</span>}
          </div>
        </div>

        <div className="np__wave">
          <div className="np__times">
            <strong>{formatDuration(player.position)}</strong>
            <span>{formatDuration(duration)}</span>
          </div>
          <Waveform
            peaks={current.peaks}
            progress={progress}
            onSeek={player.seekFraction}
            height={96}
            timeAt={(fraction) => formatDuration(fraction * duration)}
          />
        </div>

        <div className="np__controls">
          <button
            type="button"
            className={`np__control${player.shuffle ? ' is-active' : ''}`}
            aria-label="Перемешивание"
            aria-pressed={player.shuffle}
            onClick={player.toggleShuffle}
          >
            <Icon name="shuffle" size={20} />
          </button>
          <button type="button" className="np__control" aria-label="Предыдущий трек" onClick={player.prev}>
            <Icon name="prev" size={26} />
          </button>
          <button
            type="button"
            className="np__play"
            aria-label={player.playing ? 'Пауза' : 'Играть'}
            onClick={player.toggle}
          >
            <Icon name={player.playing ? 'pause' : 'play'} size={30} />
          </button>
          <button type="button" className="np__control" aria-label="Следующий трек" onClick={player.next}>
            <Icon name="next" size={26} />
          </button>
          <button
            type="button"
            className={`np__control${player.repeat !== 'off' ? ' is-active' : ''}`}
            aria-label={player.repeat === 'one' ? 'Повтор трека' : player.repeat === 'all' ? 'Повтор очереди' : 'Повтор выключен'}
            aria-pressed={player.repeat !== 'off'}
            onClick={player.cycleRepeat}
          >
            <Icon name={player.repeat === 'one' ? 'repeatOne' : 'repeat'} size={20} />
          </button>
        </div>

        <footer className="np__foot">
          <button type="button" className="np__ghost" onClick={() => player.seek(Math.max(0, player.position - 15))}>
            −15 с
          </button>
          <button
            type="button"
            className={`np__ghost${current.liked ? ' is-active' : ''}`}
            aria-label={current.liked ? 'Убрать лайк' : 'Поставить лайк'}
            aria-pressed={current.liked}
            onClick={() => void toggleLike()}
          >
            <Icon name="heart" size={18} />
          </button>
          <button
            type="button"
            className="np__ghost"
            aria-label={player.muted ? 'Включить звук' : 'Выключить звук'}
            onClick={player.toggleMute}
          >
            <Icon name={player.muted || player.volume === 0 ? 'mute' : 'volume'} size={18} />
          </button>
          <button type="button" className="np__ghost" onClick={() => player.seek(player.position + 15)}>
            +15 с
          </button>
        </footer>

        <p className="np__hint">
          Волна = пики трека: тап или перетаскивание перематывает. Esc закрывает, свайп вниз сворачивает.
          {' '}
          <button type="button" className="np__link" onClick={() => void refreshLink()}>
            обновить ссылку
          </button>
        </p>
      </div>

      {shareOpen && <ShareModal target={{ kind: 'track', track: current }} onClose={() => setShareOpen(false)} />}
    </div>
  );

  // Портал обязателен: см. комментарий к компоненту (backdrop-filter панели).
  return createPortal(content, document.body);
}
