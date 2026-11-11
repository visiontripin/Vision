import { useState } from 'react';
import {
  Image, Modal, Pressable, SafeAreaView, StyleSheet, Text, View,
} from 'react-native';
import { usePlayer } from '../player';
import { useDownloads } from '../downloads';
import { colors, radius } from '../theme';
import { Waveform } from '../components/Waveform';
import { clock } from '../lib/wave';

/**
 * Полноэкранный плеер «как в SoundCloud»: обложка на весь экран под затемнением,
 * поверх — название и артист, волна с перемоткой, крупное время, транспорт.
 *
 * Отличия от прежней версии (по отзыву владельца):
 *  - волна настоящая (320 пиков) и растянута на всю ширину, а не полоска 6 px;
 *  - перемотка — по волне, время показывается прямо над пальцем;
 *  - управление — круглые кнопки, как на референсе, а не подписи «−15 с»;
 *  - обложка больше не «висит» по центру: экран заполнен, как в макете.
 */
export function NowPlaying({
  visible,
  cover,
  onClose,
  onDownload,
  onOpenQueue,
  queueLength = 0,
}: {
  visible: boolean;
  cover?: string;
  onClose: () => void;
  onDownload: () => void;
  onOpenQueue?: () => void;
  queueLength?: number;
}) {
  const player = usePlayer();
  const downloads = useDownloads();
  const [scrubbing, setScrubbing] = useState(false);
  const track = player.current;

  if (!track) return null;

  const downloaded = downloads.has(track.checksum ?? track.id);
  const progress = downloads.progress[track.id];
  const duration = player.duration || track.duration || 0;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.screen}>
        {/* Обложка фоном: размывать её без сторонних библиотек нельзя, поэтому
            затемняем градиентом из двух слоёв — этого достаточно, чтобы текст читался. */}
        {cover ? <Image source={{ uri: cover }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
        {/* затемнение: обложка видна, но текст и волна читаются на любом кадре */}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(7,7,10,0.74)' }]} />
        <View style={styles.topShade} />

        <SafeAreaView style={styles.safe}>
          {/* верхняя панель: свернуть, «сейчас играет», скачать/очередь */}
          <View style={styles.topBar}>
            <Pressable onPress={onClose} hitSlop={12} style={styles.round} accessibilityLabel="Свернуть плеер">
              <Text style={styles.roundIcon}>⌄</Text>
            </Pressable>

            <Text style={styles.topLabel}>Сейчас играет</Text>

            <View style={styles.topActions}>
              <Pressable
                onPress={() => (onOpenQueue ? onOpenQueue() : undefined)}
                hitSlop={10}
                style={styles.round}
                accessibilityLabel={`Очередь${queueLength ? `: ${queueLength} треков` : ''}`}
              >
                <Text style={styles.roundIcon}>☰</Text>
              </Pressable>
              <Pressable
                onPress={onDownload}
                hitSlop={10}
                style={styles.round}
                accessibilityLabel={downloaded ? 'Удалить офлайн-копию' : 'Скачать офлайн'}
              >
                <Text style={[styles.roundIcon, downloaded && { color: colors.ok }]}>
                  {typeof progress === 'number' ? `${Math.round(progress * 100)}%` : downloaded ? '✓' : '↓'}
                </Text>
              </Pressable>
            </View>
          </View>

          {/* метаданные: крупно, как в карточке трека */}
          <View style={styles.meta}>
            <Text numberOfLines={2} style={styles.title}>
              {track.title}
            </Text>
            <Text numberOfLines={1} style={styles.artist}>
              {track.artist}
              {track.album ? ` — ${track.album}` : ''}
            </Text>
            <View style={styles.badges}>
              {downloaded && <Text style={styles.badge}>офлайн</Text>}
              {track.genre ? <Text style={styles.badge}>{track.genre}</Text> : null}
              <Text style={styles.badge}>{downloaded ? 'файл на телефоне' : 'поток с сервера'}</Text>
            </View>
            {player.error && <Text style={styles.error}>{player.error}</Text>}
          </View>

          <View style={styles.spacer} />

          {/* волна: главный элемент — перемотка пальцем по пикам */}
          <View style={styles.waveBlock}>
            <View style={styles.times}>
              <Text style={[styles.time, styles.timeBig]}>{clock(player.position)}</Text>
              <Text style={styles.time}>{clock(duration)}</Text>
            </View>
            <Waveform
              peaks={track.peaks ?? null}
              seed={track.id}
              position={player.position}
              duration={duration}
              playing={player.playing}
              onSeek={(seconds) => player.seekTo(seconds)}
              onScrubChange={setScrubbing}
            />
            <Text style={styles.hint}>{scrubbing ? 'Отпустите, чтобы перемотать' : 'Перетащите по волне, чтобы перемотать'}</Text>
          </View>

          {/* транспорт: shuffle · назад · play · вперёд · repeat */}
          <View style={styles.controls}>
            <Pressable onPress={player.toggleShuffle} style={styles.smallControl} accessibilityLabel="Перемешать">
              <Text style={[styles.smallText, player.shuffle && { color: colors.accent }]}>⤨</Text>
            </Pressable>

            <Pressable onPress={player.prev} style={styles.smallControl} accessibilityLabel="Предыдущий трек">
              <Text style={styles.smallText}>⏮</Text>
            </Pressable>

            <Pressable
              onPress={player.toggle}
              style={styles.play}
              accessibilityRole="button"
              accessibilityLabel={player.playing ? 'Пауза' : 'Играть'}
            >
              <Text style={styles.playText}>{player.buffering ? '…' : player.playing ? '❚❚' : '▶'}</Text>
            </Pressable>

            <Pressable onPress={player.next} style={styles.smallControl} accessibilityLabel="Следующий трек">
              <Text style={styles.smallText}>⏭</Text>
            </Pressable>

            <Pressable onPress={player.cycleRepeat} style={styles.smallControl} accessibilityLabel="Режим повтора">
              <Text style={[styles.smallText, player.repeat !== 'off' && { color: colors.accent }]}>
                {player.repeat === 'one' ? '🔂' : '🔁'}
              </Text>
            </Pressable>
          </View>

          <View style={styles.bottomRow}>
            <Pressable onPress={() => player.seekBy(-15)} style={styles.pill} accessibilityLabel="Назад на 15 секунд">
              <Text style={styles.pillText}>−15 с</Text>
            </Pressable>
            <Pressable onPress={() => player.seekBy(15)} style={styles.pill} accessibilityLabel="Вперёд на 15 секунд">
              <Text style={styles.pillText}>+15 с</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  topShade: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 190,
    backgroundColor: 'rgba(7,7,10,0.55)',
  },
  safe: { flex: 1, paddingHorizontal: 22, paddingBottom: 14 },

  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 6 },
  round: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(18,18,24,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  roundIcon: { color: colors.text, fontSize: 16, fontWeight: '700' },
  topLabel: { color: colors.muted, fontSize: 11.5, letterSpacing: 1.4, textTransform: 'uppercase', fontWeight: '700' },
  topActions: { flexDirection: 'row', gap: 8 },

  meta: { marginTop: 26, gap: 6 },
  title: { color: colors.text, fontSize: 26, lineHeight: 31, fontWeight: '800', letterSpacing: -0.6 },
  artist: { color: 'rgba(244,244,248,0.78)', fontSize: 14.5 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  badge: {
    color: 'rgba(244,244,248,0.8)',
    fontSize: 11,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: radius.pill,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  error: { color: colors.danger, fontSize: 12.5, marginTop: 6 },

  spacer: { flex: 1, minHeight: 16 },

  waveBlock: { gap: 4 },
  times: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  time: { color: 'rgba(244,244,248,0.6)', fontSize: 12, fontVariant: ['tabular-nums'] },
  timeBig: { color: colors.text, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  hint: { color: colors.dim, fontSize: 11, textAlign: 'center', marginTop: 2 },

  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 },
  smallControl: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center' },
  smallText: { color: 'rgba(244,244,248,0.85)', fontSize: 19 },
  play: {
    width: 68,
    height: 68,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.accent,
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  playText: { color: colors.accentInk, fontSize: 23, fontWeight: '800' },

  bottomRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  pill: {
    flex: 1,
    height: 44,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillText: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
});
