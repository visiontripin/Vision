import test from 'node:test';
import assert from 'node:assert/strict';
import {
  barCount,
  clock,
  isBarPlayed,
  layoutBars,
  samplePeaks,
  seekSeconds,
  waveScrollOffset,
} from './wave.ts';

/**
 * Геометрия волны: ошибки тут не ловятся типами, а проверять на телефоне
 * каждую правку дорого. Тесты держат контракт «столбцы на всю ширину»,
 * «прогресс совпадает с пальцем» и «перемотка не врёт».
 */

test('волна: число столбцов зависит от ширины и не уходит в крайности', () => {
  assert.ok(barCount(360) >= 60, 'на 360 px должно быть около 60 столбцов');
  assert.ok(barCount(360) <= 90);
  assert.equal(barCount(0), 1);
  assert.equal(barCount(Number.NaN), 1);
  assert.equal(barCount(10), 12, 'узкий экран — минимум 12 столбцов');
});

test('волна: пики усредняются до нужного числа столбцов', () => {
  const peaks = Array.from({ length: 320 }, (_, i) => (i < 160 ? 0.2 : 0.8));
  const bars = samplePeaks(peaks, 64);
  assert.equal(bars.length, 64);
  assert.ok(bars[0] < 0.35, 'тихая половина остаётся тихой');
  assert.ok(bars[63] > 0.6, 'громкая половина остаётся громкой');
  for (const value of bars) assert.ok(value >= 0.04 && value <= 1);
});

test('волна: без пиков — ровная заглушка, а не пустой экран', () => {
  const bars = samplePeaks(null, 40);
  assert.equal(bars.length, 40);
  assert.ok(bars.every((value) => value > 0));
  assert.deepEqual(samplePeaks([], 3), [0.18, 0.18, 0.18]);
});

test('волна: мусор в пиках не ломает отрисовку', () => {
  const bars = samplePeaks([Number.NaN, -3, 12, 0.5] as number[], 4);
  for (const value of bars) {
    assert.ok(Number.isFinite(value));
    assert.ok(value >= 0.04 && value <= 1);
  }
});

test('волна: проигранные столбцы совпадают с позицией пальца', () => {
  assert.equal(isBarPlayed(0, 10, 0), false);
  assert.equal(isBarPlayed(0, 10, 0.05), false);
  assert.equal(isBarPlayed(0, 10, 0.1), true, 'первый столбец закрыт на 10%');
  assert.equal(isBarPlayed(4, 10, 0.5), true);
  assert.equal(isBarPlayed(5, 10, 0.5), false);
  assert.equal(isBarPlayed(9, 10, 1), true);
});

test('волна: раскладка заполняет всю ширину и не наезжает на зазоры', () => {
  const width = 360;
  const bars = 60;
  const layout = layoutBars(width, 80, bars);
  assert.equal(layout.length, bars);
  assert.equal(layout[0].x, 0);
  const step = width / bars;
  assert.ok(Math.abs(layout[1].x - step) < 1e-9);
  const last = layout[layout.length - 1];
  assert.ok(last.x + step <= width + 1e-9, 'волна не вылезает за экран');
  for (const bar of layout) assert.ok(bar.width >= 1);
});

test('волна: автоскролл держит играющий столбец в центре', () => {
  const bars = 240;
  const width = 1440; // 240 столбцов × 6 px
  const viewport = 360;

  assert.equal(waveScrollOffset(0.5, 20, 200, viewport), null, 'короткая волна не скроллится');

  const start = waveScrollOffset(0, bars, width, viewport);
  assert.equal(start, 0, 'в начале не уезжаем в минус');

  const middle = waveScrollOffset(0.5, bars, width, viewport);
  assert.ok(middle !== null);
  // в центре — центр играющего столбца, а не его левый край
  const expected = width / 2 - viewport / 2 + (width / bars) / 2;
  assert.ok(Math.abs((middle ?? 0) - expected) < 0.5);

  const end = waveScrollOffset(1, bars, width, viewport);
  assert.equal(end, width - viewport, 'в конце упираемся в правый край');
});

test('волна: перемотка по доле даёт правильные секунды', () => {
  assert.equal(seekSeconds(0.5, 348), 174);
  assert.equal(seekSeconds(0.25, 100), 25);
  assert.equal(seekSeconds(-1, 100), 0);
  assert.equal(seekSeconds(2, 100), 100);
  assert.equal(seekSeconds(0.5, 0), 0);
  assert.equal(seekSeconds(0.333, 90), 30);
});

test('волна: крупное время в формате плеера', () => {
  assert.equal(clock(36), '0:36');
  assert.equal(clock(348), '5:48');
  assert.equal(clock(3729), '1:02:09');
  assert.equal(clock(0), '0:00');
  assert.equal(clock(Number.NaN), '0:00');
});
