import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { pseudoPeaks } from '@vision/shared';
import { colors, radius } from '../theme';
import { Cover } from './Cover';
import { usePlayer } from '../player';
import { samplePeaks } from '../lib/wave';

/**
 * Мини-плеер над списком — вход в полноэкранный плеер.
 *
 * Всё, кроме кнопок play/next, — одна зона нажатия «открыть плеер»: на телефоне
 * человек целится в полоску целиком, а не в стрелку «развернуть». Прогресс
 * нарисован мини-волной (32 столбца из тех же пиков), чтобы снизу было видно
 * «где я в треке», как в SoundCloud Go.
 */
const MINI_BARS = 32;

export function MiniPlayer({ cover, onOpen }: { cover?: string; onOpen: () => void }) {
  const { current, playing, position, duration, toggle, next, buffering } = usePlayer();

  const bars = useMemo(() => {
    if (!current) return [];
    return samplePeaks(current.peaks ?? pseudoPeaks(current.id, 120), MINI_BARS);
  }, [current]);

  if (!current) return null;

  const ratio = duration > 0 ? Math.min(1, position / duration) : 0;

  return (
    <Pressable
      style={styles.wrapper}
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`Открыть плеер: ${current.title}, ${current.artist}`}
      accessibilityHint="Открывает плеер с волной и перемоткой"
    >
      <View style={styles.wave} pointerEvents="none">
        {bars.map((value, index) => {
          const played = (index + 1) / bars.length <= ratio;
          return (
            <View
              key={index}
              style={{
                flex: 1,
                height: Math.max(2, Math.round(value * 18)),
                borderRadius: 1,
                backgroundColor: played ? colors.accent : 'rgba(255,255,255,0.2)',
              }}
            />
          );
        })}
      </View>

      <View style={styles.body}>
        <Cover uri={cover} title={current.title} size={40} />

        <View style={styles.info}>
          <Text numberOfLines={1} style={styles.title}>
            {current.title}
          </Text>
          <Text numberOfLines={1} style={styles.artist}>
            {buffering ? 'Буферизация…' : `${current.artist} · нажмите, чтобы открыть`}
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

        <View style={styles.chevronWrap} pointerEvents="none">
          <Text style={styles.chevron}>⌃</Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: '#101017',
    borderTopWidth: 1,
    borderColor: colors.border,
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    overflow: 'hidden',
  },
  wave: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 18,
    paddingHorizontal: 12,
    paddingTop: 4,
  },
  body: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
  },
  info: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 14, fontWeight: '700' },
  artist: { color: colors.muted, fontSize: 11.5, marginTop: 2 },
  play: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: { color: colors.accentInk, fontSize: 14, fontWeight: '800' },
  next: { paddingHorizontal: 2, paddingVertical: 8 },
  nextIcon: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  chevronWrap: { width: 14, alignItems: 'center' },
  chevron: { color: colors.dim, fontSize: 14, fontWeight: '700' },
});
