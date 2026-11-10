import { useRef, useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { colors } from '../theme';

/**
 * Полоса прогресса с перетаскиванием: `onLayout` даёт ширину, нажатие/жест —
 * долю 0..1. Без внешних зависимостей (слайдеры в RN приходят из community-пакета).
 */
export function ProgressBar({
  value,
  onSeek,
  height = 6,
  disabled = false,
}: {
  value: number;
  onSeek: (fraction: number) => void;
  height?: number;
  disabled?: boolean;
}) {
  const widthRef = useRef(1);
  const [dragging, setDragging] = useState(false);

  const onLayout = (event: LayoutChangeEvent) => {
    widthRef.current = Math.max(1, event.nativeEvent.layout.width);
  };

  const seek = (x: number) => {
    if (disabled) return;
    onSeek(Math.min(1, Math.max(0, x / widthRef.current)));
  };

  const ratio = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

  return (
    <Pressable
      onLayout={onLayout}
      onPressIn={(event) => {
        setDragging(true);
        seek(event.nativeEvent.locationX);
      }}
      onPressOut={() => setDragging(false)}
      onTouchMove={(event) => {
        if (dragging) seek(event.nativeEvent.locationX);
      }}
      style={styles.hit}
      accessibilityRole="adjustable"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(ratio * 100) }}
    >
      <View style={[styles.track, { height, borderRadius: height }]}>
        <View
          style={{
            width: `${ratio * 100}%`,
            height,
            borderRadius: height,
            backgroundColor: colors.accent,
          }}
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hit: { paddingVertical: 10, justifyContent: 'center' },
  track: { backgroundColor: '#2a2a34', overflow: 'hidden' },
});
