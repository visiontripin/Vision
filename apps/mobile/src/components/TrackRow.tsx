import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Track } from '@vision/shared';
import { formatDuration } from '@vision/shared';
import { colors, radius } from '../theme';
import { Cover } from './Cover';

export function TrackRow({
  track,
  cover,
  active,
  playing,
  downloaded,
  progress,
  onPress,
  onLongPress,
  onToggleDownload,
}: {
  track: Track;
  cover?: string;
  active: boolean;
  playing: boolean;
  downloaded: boolean;
  progress?: number;
  onPress: () => void;
  onLongPress: () => void;
  onToggleDownload: () => void;
}) {
  const downloading = typeof progress === 'number';

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [styles.row, active && styles.rowActive, pressed && styles.rowPressed]}
    >
      <Cover uri={cover} title={track.title} size={46} />

      <View style={styles.info}>
        <Text numberOfLines={1} style={[styles.title, active && { color: colors.accentSoft }]}>
          {track.title}
        </Text>
        <Text numberOfLines={1} style={styles.artist}>
          {track.artist}
          {track.genre ? ` · ${track.genre}` : ''}
        </Text>
      </View>

      <Text style={styles.time}>{active && playing ? '▮▮▮' : formatDuration(track.duration)}</Text>

      <Pressable
        onPress={onToggleDownload}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={downloaded ? 'Удалить офлайн-копию' : 'Скачать офлайн'}
        style={styles.download}
      >
        <Text style={[styles.downloadIcon, downloaded && { color: colors.ok }]}>
          {downloading ? `${Math.round((progress ?? 0) * 100)}%` : downloaded ? '✓' : '↓'}
        </Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  rowActive: { backgroundColor: 'rgba(255,90,31,0.10)' },
  rowPressed: { opacity: 0.75 },
  info: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
  artist: { color: colors.muted, fontSize: 12.5, marginTop: 2 },
  time: { color: colors.dim, fontSize: 11.5, fontVariant: ['tabular-nums'] },
  download: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  downloadIcon: { color: colors.dim, fontSize: 14, fontWeight: '700' },
});
