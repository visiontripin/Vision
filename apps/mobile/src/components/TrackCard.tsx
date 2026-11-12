import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../theme';
import { Cover } from './Cover';

/**
 * Строка трека как в референсе: крупная обложка 56, название жирным, артист
 * серым, ниже — «▸ прослушивания · время» и точка источника (чьё устройство).
 *
 * Отдельный компонент, а не флаги в старом `TrackRow`: в ленте у трека два
 * разных состояния (свой файл / чужой, доступный по сети), и смешивать их с
 * «скачано офлайн» в одном наборе флагов — значит получить нечитаемый набор
 * условий в экране.
 */
export function TrackCard({
  title,
  artist,
  cover,
  duration,
  plays,
  active,
  playing,
  sourceLabel,
  unavailable,
  onPress,
  onLongPress,
  onMenu,
  showMenu = true,
}: {
  title: string;
  artist: string;
  cover?: string | null;
  duration: number;
  plays?: number;
  active?: boolean;
  playing?: boolean;
  /** «на этом телефоне» / «Телефон Ани» */
  sourceLabel?: string;
  /** трек виден, но скачать неоткуда — показываем это, а не молчим */
  unavailable?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  onMenu?: () => void;
  showMenu?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={320}
      style={({ pressed }) => [styles.row, active && styles.rowActive, pressed && styles.rowPressed]}
    >
      <Cover uri={cover} title={title} size={56} />

      <View style={styles.info}>
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        <Text numberOfLines={1} style={styles.artist}>
          {artist || 'Без исполнителя'}
        </Text>

        <View style={styles.metaRow}>
          {active && playing ? (
            <Text style={[styles.meta, styles.metaPlaying]}>▮▮▮</Text>
          ) : (
            <>
              {typeof plays === 'number' && plays > 0 && <Text style={styles.meta}>▸ {plays}</Text>}
              <Text style={styles.meta}>{clock(duration)}</Text>
            </>
          )}
          {sourceLabel ? (
            <Text numberOfLines={1} style={[styles.meta, styles.source, unavailable && styles.sourceWarn]}>
              {unavailable ? 'нет на связи' : sourceLabel}
            </Text>
          ) : null}
        </View>
      </View>

      {showMenu && (
        <Pressable
          onPress={onMenu}
          onLongPress={onLongPress}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Действия с треком"
          style={styles.menuButton}
        >
          <Text style={styles.menuDots}>⋮</Text>
        </Pressable>
      )}
    </Pressable>
  );
}

/** `3:54` — как в референсе, без часов у коротких треков. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowActive: { backgroundColor: 'rgba(255,90,31,0.08)' },
  rowPressed: { opacity: 0.72 },
  info: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  artist: { color: colors.muted, fontSize: 13.5, marginTop: 3 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 5 },
  meta: { color: colors.dim, fontSize: 11.5, fontVariant: ['tabular-nums'] },
  metaPlaying: { color: colors.accent, letterSpacing: 1 },
  source: { color: '#7d7d90', maxWidth: 150 },
  sourceWarn: { color: '#ff9f6b' },
  menuButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
  menuDots: { color: '#8b8b9c', fontSize: 20, fontWeight: '700' },
});
