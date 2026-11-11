import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { pseudoPeaks } from '@vision/shared';
import { colors } from '../theme';
import { barCount, clock, isBarPlayed, samplePeaks, seekSeconds, waveScrollOffset, BAR_GAP } from '../lib/wave';

/**
 * Волна трека как в SoundCloud: 320 пиков из API, столбцы на всю ширину,
 * проигранная часть — акцентным цветом, длинный трек скроллится и сам подводит
 * играющий столбец к центру.
 *
 * Масштаб: один столбец на 2 секунды, но не меньше, чем нужно для заполнения
 * экрана. 30-секундный трек — во всю ширину без скролла, 5-минутный — примерно
 * три экрана, как у SoundCloud.
 *
 * Жест: `PanResponder` на зоне высотой 92 px. Пока тянем — время показываем
 * над пальцем (лейбл абсолютный, не мешает вёрстке); отпустили — один seek.
 * `onSeek` принимает секунды, а не долю: экран не зависит от того, догрузилась
 * ли длительность.
 */
const SECONDS_PER_BAR = 2;
const MAX_BARS = 1200;
const WAVE_HEIGHT = 92;

export function Waveform({
  peaks,
  seed,
  position,
  duration,
  playing,
  onSeek,
  onScrubChange,
}: {
  /** пики из `/api/media` (0..1) или null, если сервер их не считал */
  peaks: number[] | null;
  /** ключ для «псевдо-волны», когда пиков нет */
  seed: string;
  position: number;
  duration: number;
  playing: boolean;
  onSeek: (seconds: number) => void;
  /** начало/конец перетаскивания: экран понимает, что время сейчас «чужое» */
  onScrubChange?: (scrubbing: boolean) => void;
}) {
  const [viewport, setViewport] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);

  const scrollRef = useRef<ScrollView>(null);
  const offsetRef = useRef(0);
  const scrubRef = useRef<number | null>(null);
  const durationRef = useRef(duration);
  const waveWidthRef = useRef(1);

  durationRef.current = duration;

  /* Сколько столбцов: заполняем экран, но у длинных треков волна шире экрана. */
  const total = useMemo(() => {
    if (!viewport) return 0;
    const minimal = barCount(viewport);
    const byDuration = Math.round((Math.max(0, duration) || 0) / SECONDS_PER_BAR);
    return Math.max(minimal, Math.min(MAX_BARS, byDuration || minimal));
  }, [viewport, duration]);

  const values = useMemo(
    () => (total ? samplePeaks(peaks ?? pseudoPeaks(seed, 320), total) : []),
    [peaks, seed, total]
  );

  const barWidth = total && viewport ? Math.max(1, viewport / barCount(viewport) - BAR_GAP) : 3;
  const waveWidth = total ? Math.round(total * (barWidth + BAR_GAP)) : 0;

  const ratio = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
  const shown = scrub ?? ratio;

  const seekAt = useCallback((x: number) => {
    const width = waveWidthRef.current || 1;
    const fraction = Math.min(1, Math.max(0, x / width));
    scrubRef.current = fraction;
    setScrub(fraction);
    onSeek(seekSeconds(fraction, durationRef.current));
  }, [onSeek]);

  const finish = useCallback(() => {
    onScrubChange?.(false);
    scrubRef.current = null;
    setScrub(null);
  }, [onScrubChange]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          onScrubChange?.(true);
          seekAt(event.nativeEvent.locationX + offsetRef.current);
        },
        onPanResponderMove: (event) => {
          seekAt(event.nativeEvent.locationX + offsetRef.current);
        },
        onPanResponderRelease: finish,
        onPanResponderTerminate: finish,
      }),
    [seekAt, finish, onScrubChange]
  );

  waveWidthRef.current = waveWidth || 1;

  /* Пока играем — держим играющий столбец в центре; пока тянем пальцем — не трогаем. */
  useEffect(() => {
    if (scrubRef.current !== null) return;
    const target = waveScrollOffset(ratio, total, waveWidth, viewport);
    if (target === null) return;
    scrollRef.current?.scrollTo({ x: target, animated: Math.abs(target - offsetRef.current) < viewport });
  }, [ratio, total, waveWidth, viewport]);

  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.max(1, event.nativeEvent.layout.width);
    if (Math.abs(next - viewport) > 0.5) setViewport(next);
  };

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      <ScrollView
        ref={scrollRef}
        horizontal
        scrollEnabled={waveWidth > viewport + 1}
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={(event) => {
          offsetRef.current = event.nativeEvent.contentOffset.x;
        }}
      >
        <View
          style={[styles.canvas, { width: waveWidth || '100%' }]}
          {...(waveWidth ? pan.panHandlers : {})}
          accessibilityRole="adjustable"
          accessibilityLabel="Волна трека: перетащите, чтобы перемотать"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(shown * 100) }}
        >
          {values.map((value, index) => (
            <View
              key={index}
              style={{
                width: barWidth,
                height: Math.max(3, Math.round(value * WAVE_HEIGHT)),
                borderRadius: Math.min(barWidth / 2, 2),
                backgroundColor: isBarPlayed(index, values.length, shown)
                  ? colors.accent
                  : 'rgba(255,255,255,0.24)',
              }}
            />
          ))}
        </View>
      </ScrollView>

      {/* Пока палец на волне — время рядом; в покое лейбл не нужен, время есть в транспорте. */}
      {scrub !== null && duration > 0 && (
        <View pointerEvents="none" style={styles.scrubLabel}>
          <Text style={styles.scrubText}>
            {clock(seekSeconds(scrub, duration))} / {clock(duration)}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', marginTop: 4 },
  canvas: {
    minWidth: '100%',
    height: WAVE_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: BAR_GAP,
  },
  scrubLabel: {
    position: 'absolute',
    top: -22,
    alignSelf: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(10,10,14,0.92)',
    borderWidth: 1,
    borderColor: colors.border,
  },
  scrubText: { color: colors.text, fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
