import { useState } from 'react';
import {
  Image, Modal, Pressable, SafeAreaView, StyleSheet, Text, View,
} from 'react-native';
import { usePlayer } from '../player';
import { useLocalLibrary } from '../local';
import { useSync } from '../sync';
import { colors, radius } from '../theme';
import { Waveform } from '../components/Waveform';
import { clock as timecode } from '../lib/wave';

/**
 * Полноэкранный плеер по референсу SoundCloud Go.
 *
 * Что изменено после сравнения с референсом:
 *  - обложка трека — **фон на весь экран**, а не пустое поле: так экран узнаётся
 *    сразу, и не нужно угадывать, что играет;
 *  - название и артист слева сверху, как в референсе, а не в центре;
 *  - круг «свернуть» в правом верхнем углу;
 *  - волна во всю ширину, под ней время: проигранное крупно, остаток — справа;
 *  - транспорт: shuffle, назад, большая круглая play, вперёд, repeat — без ряда
 *    «−15 с / +15 с», которого в референсе нет (перемотка идёт по волне).
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
  onDownload?: () => void;
  onOpenQueue?: () => void;
  queueLength?: number;
}) {
  const player = usePlayer();
  const local = useLocalLibrary();
  const sync = useSync();
  const [scrubbing, setScrubbing] = useState(false);
  const track = player.current;

  if (!track) return null;

  const duration = player.duration || track.duration || 0;
  const isLocal = Boolean(local.uriOf(track.id));
  const shared = sync.feed.find((item) => item.id === track.id);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.screen}>
        {/* фон: обложка, если она есть; иначе — тёмный градиент из двух слоёв */}
        {cover ? <Image source={{ uri: cover }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: cover ? 'rgba(7,7,10,0.72)' : 'rgba(7,7,10,0.9)' }]} />
        <View style={styles.topShade} />

        <SafeAreaView style={styles.safe}>
          {/* верх: как в референсе — имя слева, круглая кнопка справа */}
          <View style={styles.topBar}>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={styles.title}>
                {track.title}
              </Text>
              <Text numberOfLines={1} style={styles.artist}>
                {track.artist || 'Без исполнителя'}
              </Text>
              <View style={styles.badges}>
                <Text style={styles.badge}>{isLocal ? 'на телефоне' : 'из общей библиотеки'}</Text>
                {shared && !shared.mine ? <Text style={styles.badge}>{shared.deviceName}</Text> : null}
              </View>
            </View>

            <Pressable onPress={onClose} hitSlop={12} style={styles.round} accessibilityLabel="Свернуть плеер">
              <Text style={styles.roundIcon}>⌄</Text>
            </Pressable>
          </View>

          <View style={styles.spacer} />

          {/* волна: главный элемент, перемотка пальцем */}
          <View style={styles.waveBlock}>
            <Waveform
              peaks={track.peaks ?? null}
              seed={track.id}
              position={player.position}
              duration={duration}
              playing={player.playing}
              onSeek={(seconds) => player.seekTo(seconds)}
              onScrubChange={setScrubbing}
            />
            <View style={styles.times}>
              <Text style={styles.timeNow}>{timecode(player.position)}</Text>
              <Text style={styles.timeTotal}>{timecode(duration)}</Text>
            </View>
            <Text style={styles.hint}>
              {scrubbing ? 'Отпустите, чтобы перемотать' : 'Перетащите по волне, чтобы перемотать'}
            </Text>
          </View>

          {/* транспорт */}
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

          {/* нижний ряд как в референсе: лайк, комментарии(счётчик), «поделиться», очередь, меню */}
          <View style={styles.bottomBar}>
            <Pressable onPress={() => undefined} style={styles.bottomItem} accessibilityLabel="Нравится">
              <Text style={[styles.bottomIcon, track.liked && { color: colors.accent }]}>♥</Text>
            </Pressable>
            <Pressable onPress={() => undefined} style={styles.bottomItem} accessibilityLabel="Комментарии">
              <Text style={styles.bottomIcon}>☰</Text>
            </Pressable>
            <Pressable onPress={onDownload ?? (() => undefined)} style={styles.bottomItem} accessibilityLabel="Скачать">
              <Text style={styles.bottomIcon}>↓</Text>
            </Pressable>
            <Pressable onPress={() => onOpenQueue?.()} style={styles.bottomItem} accessibilityLabel="Очередь">
              <Text style={styles.bottomIcon}>≡</Text>
              {queueLength > 0 ? <Text style={styles.queueCount}>{queueLength}</Text> : null}
            </Pressable>
            <Pressable onPress={onClose} style={styles.bottomItem} accessibilityLabel="Закрыть">
              <Text style={styles.bottomIcon}>⋮</Text>
            </Pressable>
          </View>

          {player.error ? <Text style={styles.error}>{player.error}</Text> : null}
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
    backgroundColor: 'rgba(7,7,10,0.5)',
  },
  safe: { flex: 1, paddingHorizontal: 20, paddingBottom: 10 },

  topBar: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingTop: 8 },
  title: { color: colors.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.8 },
  artist: { color: 'rgba(244,244,248,0.78)', fontSize: 17, marginTop: 4 },
  badges: { flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  badge: {
    color: 'rgba(244,244,248,0.82)',
    fontSize: 11,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: radius.pill,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  round: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(18,18,24,0.7)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  roundIcon: { color: colors.text, fontSize: 18, fontWeight: '700' },

  spacer: { flex: 1, minHeight: 20 },

  waveBlock: { gap: 6 },
  times: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 },
  timeNow: { color: colors.text, fontSize: 26, fontWeight: '800', fontVariant: ['tabular-nums'] },
  timeTotal: { color: 'rgba(244,244,248,0.55)', fontSize: 15, fontVariant: ['tabular-nums'] },
  hint: { color: colors.dim, fontSize: 11.5, textAlign: 'center' },

  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 },
  smallControl: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center' },
  smallText: { color: 'rgba(244,244,248,0.9)', fontSize: 20 },
  play: {
    width: 72,
    height: 72,
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
  playText: { color: colors.accentInk, fontSize: 24, fontWeight: '800' },

  bottomBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16, paddingHorizontal: 4 },
  bottomItem: { alignItems: 'center', justifyContent: 'center', minWidth: 44, height: 40 },
  bottomIcon: { color: 'rgba(244,244,248,0.85)', fontSize: 19 },
  queueCount: { color: colors.accent, fontSize: 10, fontWeight: '700', marginTop: -2 },
  error: { color: colors.danger, fontSize: 12.5, marginTop: 8, textAlign: 'center' },
});
