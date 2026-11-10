import { Dimensions, Modal, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { formatDuration } from '@vision/shared';
import { usePlayer } from '../player';
import { useDownloads } from '../downloads';
import { colors, radius } from '../theme';
import { Cover } from '../components/Cover';
import { ProgressBar } from '../components/ProgressBar';

/** Полноэкранный плеер: обложка, перемотка, очередь, офлайн-копия. */
export function NowPlaying({
  visible,
  cover,
  onClose,
  onDownload,
}: {
  visible: boolean;
  cover?: string;
  onClose: () => void;
  onDownload: () => void;
}) {
  const player = usePlayer();
  const downloads = useDownloads();
  const track = player.current;

  if (!track) return null;

  const size = Math.min(Dimensions.get('window').width - 72, 300);
  const downloaded = downloads.has(track.id);
  const progress = downloads.progress[track.id];
  const ratio = player.duration > 0 ? player.position / player.duration : 0;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <SafeAreaView style={styles.screen}>
        <View style={styles.topBar}>
          <Pressable onPress={onClose} style={styles.iconButton} accessibilityLabel="Свернуть плеер">
            <Text style={styles.iconText}>⌄</Text>
          </Pressable>
          <Text style={styles.topLabel}>{downloaded ? 'Офлайн-копия' : 'Поток с сервера'}</Text>
          <Pressable
            onPress={onDownload}
            style={styles.iconButton}
            accessibilityLabel={downloaded ? 'Удалить офлайн-копию' : 'Скачать офлайн'}
          >
            <Text style={[styles.iconText, downloaded && { color: colors.ok }]}>
              {typeof progress === 'number' ? `${Math.round(progress * 100)}%` : downloaded ? '✓' : '↓'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.artWrap}>
          <Cover uri={cover} title={track.title} size={size} />
        </View>

        <View style={styles.meta}>
          <Text numberOfLines={2} style={styles.title}>
            {track.title}
          </Text>
          <Text numberOfLines={1} style={styles.artist}>
            {track.artist}
            {track.album ? ` — ${track.album}` : ''}
          </Text>
          {player.error && <Text style={styles.error}>{player.error}</Text>}
        </View>

        <View style={styles.seek}>
          <ProgressBar value={ratio} onSeek={(fraction) => player.seekTo(fraction * (player.duration || 0))} />
          <View style={styles.times}>
            <Text style={styles.time}>{formatDuration(player.position)}</Text>
            <Text style={styles.time}>{formatDuration(player.duration || track.duration)}</Text>
          </View>
        </View>

        <View style={styles.controls}>
          <Pressable onPress={player.toggleShuffle} style={styles.smallControl} accessibilityLabel="Перемешать">
            <Text style={[styles.smallText, player.shuffle && { color: colors.accent }]}>⤨</Text>
          </Pressable>

          <Pressable onPress={player.prev} style={styles.smallControl} accessibilityLabel="Предыдущий трек">
            <Text style={styles.smallText}>⏮</Text>
          </Pressable>

          <Pressable onPress={player.toggle} style={styles.play} accessibilityLabel={player.playing ? 'Пауза' : 'Играть'}>
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

        <View style={styles.secondary}>
          <Pressable onPress={() => player.seekBy(-15)} style={styles.secondaryButton}>
            <Text style={styles.secondaryText}>−15 с</Text>
          </Pressable>
          <Pressable onPress={() => player.seekBy(15)} style={styles.secondaryButton}>
            <Text style={styles.secondaryText}>+15 с</Text>
          </Pressable>
        </View>

        <Text style={styles.hint}>
          В фоне музыка продолжается; управление с экрана блокировки — в следующей сборке
          (react-native-track-player).
        </Text>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 24 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8 },
  iconButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  iconText: { color: colors.muted, fontSize: 18, fontWeight: '700' },
  topLabel: { color: colors.dim, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: 1 },
  artWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  meta: { gap: 6 },
  title: { color: colors.text, fontSize: 22, fontWeight: '800', lineHeight: 27 },
  artist: { color: colors.muted, fontSize: 13.5 },
  error: { color: colors.danger, fontSize: 12.5, marginTop: 4 },
  seek: { marginTop: 18 },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  time: { color: colors.dim, fontSize: 11.5, fontVariant: ['tabular-nums'] },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 },
  smallControl: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  smallText: { color: colors.muted, fontSize: 18 },
  play: {
    width: 66,
    height: 66,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playText: { color: colors.accentInk, fontSize: 22, fontWeight: '800' },
  secondary: { flexDirection: 'row', gap: 10, marginTop: 10 },
  secondaryButton: {
    flex: 1,
    height: 42,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  hint: { color: colors.dim, fontSize: 11, lineHeight: 16, marginTop: 14, marginBottom: 8, textAlign: 'center' },
});
