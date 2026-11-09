import { formatDuration, formatBytes } from '@vision/shared';
import { api } from '../api';
import { useLibrary } from '../state/library';
import { usePlayer } from '../state/player';
import { Cover, Icon, useToast, Waveform } from '../ui';

export function PlayerBar() {
  const player = usePlayer();
  const { patchTrack } = useLibrary();
  const { push } = useToast();

  const current = player.current;
  if (!current) return null;

  const progress = player.duration > 0 ? Math.min(1, player.position / player.duration) : 0;

  const toggleLike = async () => {
    try {
      const updated = await api.setLiked(current.id, !current.liked);
      patchTrack(current.id, { liked: updated.liked });
      player.replaceTrack(updated);
    } catch (error) {
      push(error instanceof Error ? error.message : 'Не удалось обновить лайк', 'error');
    }
  };

  return (
    <div className="player" role="region" aria-label="Плеер">
      <div className="player__now">
        <Cover track={current} size={52} />
        <div className="player__meta">
          <span className="player__title" title={current.title}>
            {current.title}
          </span>
          <span className="player__artist">{current.artist}</span>
        </div>
        <button
          type="button"
          className={`iconbtn player__like${current.liked ? ' is-active' : ''}`}
          aria-label={current.liked ? 'Убрать лайк' : 'Поставить лайк'}
          aria-pressed={current.liked}
          onClick={toggleLike}
        >
          <Icon name="heart" size={18} />
        </button>
      </div>

      <div className="player__center">
        <div className="player__controls">
          <button
            type="button"
            className={`iconbtn${player.shuffle ? ' is-active' : ''}`}
            aria-label="Перемешивание"
            aria-pressed={player.shuffle}
            onClick={player.toggleShuffle}
          >
            <Icon name="shuffle" size={17} />
          </button>
          <button type="button" className="iconbtn" aria-label="Предыдущий трек" onClick={player.prev}>
            <Icon name="prev" size={19} />
          </button>
          <button
            type="button"
            className="playbtn"
            aria-label={player.playing ? 'Пауза' : 'Играть'}
            onClick={player.toggle}
          >
            <Icon name={player.playing ? 'pause' : 'play'} size={20} />
          </button>
          <button type="button" className="iconbtn" aria-label="Следующий трек" onClick={player.next}>
            <Icon name="next" size={19} />
          </button>
          <button
            type="button"
            className={`iconbtn${player.repeat !== 'off' ? ' is-active' : ''}`}
            aria-label={
              player.repeat === 'off'
                ? 'Повтор выключен'
                : player.repeat === 'all'
                  ? 'Повтор очереди'
                  : 'Повтор трека'
            }
            aria-pressed={player.repeat !== 'off'}
            onClick={player.cycleRepeat}
          >
            <Icon name={player.repeat === 'one' ? 'repeatOne' : 'repeat'} size={17} />
          </button>
        </div>

        <div className="player__wave">
          <span className="player__time">{formatDuration(player.position)}</span>
          <Waveform
            peaks={current.peaks}
            progress={progress}
            onSeek={player.seekFraction}
            height={38}
          />
          <span className="player__time">{formatDuration(player.duration || current.duration)}</span>
        </div>
      </div>

      <div className="player__right">
        <button
          type="button"
          className="iconbtn"
          aria-label={player.muted ? 'Включить звук' : 'Выключить звук'}
          onClick={player.toggleMute}
        >
          <Icon name={player.muted || player.volume === 0 ? 'mute' : 'volume'} size={18} />
        </button>
        <input
          className="volume"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={player.muted ? 0 : player.volume}
          aria-label="Громкость"
          onChange={(event) => player.setVolume(Number(event.target.value))}
        />
        <button
          type="button"
          className="iconbtn"
          aria-label="Очередь воспроизведения"
          aria-expanded={player.queueOpen}
          onClick={() => player.setQueueOpen(!player.queueOpen)}
        >
          <Icon name="queue" size={19} />
        </button>
      </div>
    </div>
  );
}

export function QueueDrawer() {
  const player = usePlayer();

  if (!player.queueOpen) return null;

  return (
    <>
      <div className="drawer__backdrop" onClick={() => player.setQueueOpen(false)} />
      <aside className="drawer" aria-label="Очередь воспроизведения">
        <header className="drawer__head">
          <div>
            <h2>Очередь</h2>
            <p>{player.queue.length} треков · {formatBytes(player.queue.reduce((sum, t) => sum + t.size, 0))}</p>
          </div>
          <button
            type="button"
            className="iconbtn"
            aria-label="Закрыть очередь"
            onClick={() => player.setQueueOpen(false)}
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="drawer__list">
          {player.queue.map((track, index) => {
            const isCurrent = player.current?.id === track.id;
            return (
              <div
                key={`${track.id}-${index}`}
                className={`drawer__row${isCurrent ? ' is-current' : ''}`}
                onClick={() => player.playQueue(player.queue, index)}
              >
                <span className="drawer__num">{isCurrent ? <Icon name="play" size={12} /> : index + 1}</span>
                <Cover track={track} size={36} />
                <div className="drawer__meta">
                  <span className="drawer__title">{track.title}</span>
                  <span className="drawer__artist">{track.artist}</span>
                </div>
                <span className="drawer__time">{formatDuration(track.duration)}</span>
                <button
                  type="button"
                  className="iconbtn"
                  aria-label="Убрать из очереди"
                  onClick={(event) => {
                    event.stopPropagation();
                    player.removeFromQueue(track.id);
                  }}
                >
                  <Icon name="close" size={15} />
                </button>
              </div>
            );
          })}
        </div>
      </aside>
    </>
  );
}
