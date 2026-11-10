import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../theme';
import { Cover } from './Cover';
import { usePlayer } from '../player';

/** Компактный плеер над списком: играет всегда, разворачивается по нажатию. */
export function MiniPlayer({ cover, onOpen }: { cover?: string; onOpen: () => void }) {
  const { current, playing, position, duration, toggle, next, buffering } = usePlayer();
  if (!current) return null;

  const ratio = duration > 0 ? Math.min(1, position / duration) : 0;

  return (
    <Pressable style={styles.wrapper} onPress={onOpen} accessibilityRole="button" accessibilityLabel="Открыть плеер">
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${ratio * 100}%` }]} />
      </View>

      <View style={styles.body}>
        <Cover uri={cover} title={current.title} size={40} />

        <View style={styles.info}>
          <Text numberOfLines={1} style={styles.title}>
            {current.title}
          </Text>
          <Text numberOfLines={1} style={styles.artist}>
            {buffering ? 'Буферизация…' : current.artist}
          </Text>
        </View>

        <Pressable
          onPress={toggle}
          hitSlop={10}
          style={styles.play}
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Пауза' : 'Играть'}
        >
          <Text style={styles.playIcon}>{playing ? '❚❚' : '▶'}</Text>
        </Pressable>

        <Pressable onPress={next} hitSlop={10} style={styles.next} accessibilityRole="button" accessibilityLabel="Следующий трек">
          <Text style={styles.nextIcon}>▶▶</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: colors.panel,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  progressTrack: { height: 2, backgroundColor: '#2a2a34' },
  progressFill: { height: 2, backgroundColor: colors.accent },
  body: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  info: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 14, fontWeight: '700' },
  artist: { color: colors.muted, fontSize: 12, marginTop: 2 },
  play: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: { color: colors.accentInk, fontSize: 14, fontWeight: '800' },
  next: { paddingHorizontal: 4, paddingVertical: 8 },
  nextIcon: { color: colors.muted, fontSize: 12, fontWeight: '700' },
});
