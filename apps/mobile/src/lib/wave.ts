/**
 * Геометрия волны для полноэкранного плеера.
 *
 * Вынесена из компонента, чтобы покрыть тестами: ошибки здесь видны глазом
 * («волна не доходит до края», «прогресс убегает от пальца»), но не ловятся
 * типами, а на телефоне каждую правку проверять дорого.
 *
 * Вход — «пики» трека (0..1, до 400 значений из API) или `null`, если сервер их
 * не прислал. Выход — массив высот 0..1 ровно на `bars` столбцов.
 */

/** Сколько столбцов рисуем: один столбец ≈ 4 px + 2 px зазор — как в вебе. */
export const BAR_GAP = 2;
export const BAR_MIN_WIDTH = 2;
export const BAR_MAX_WIDTH = 5;

export function barCount(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  // ширина столбца 4 px вместе с зазором; минимум 12 столбцов, чтобы волна
  // не превращалась в три полоски на узком экране
  const width4 = BAR_MAX_WIDTH - 1;
  return Math.max(12, Math.floor(width / (width4 + BAR_GAP)));
}

/**
 * Усредняет пики по окнам и слегка сглаживает соседей: сырые 320 значений на
 * 60 столбцов дают «дребезг» на тихих участках. Значения клэмпятся в 0.04..1,
 * чтобы тишина оставалась видимой линией, а не пропадала.
 */
export function samplePeaks(values: number[] | null | undefined, bars: number): number[] {
  const count = Math.max(1, Math.trunc(bars));
  const source = (values ?? []).map((raw) => {
    const value = Number(raw);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  });

  if (!source.length) return new Array(count).fill(0.18);

  const span = source.length / count;
  const sampled = Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * span);
    const end = Math.max(start + 1, Math.floor((index + 1) * span));
    let sum = 0;
    let used = 0;
    for (let i = start; i < end && i < source.length; i += 1) {
      sum += source[i] ?? 0;
      used += 1;
    }
    return used ? sum / used : 0;
  });

  return sampled.map((value, index) => {
    const prev = sampled[index - 1] ?? value;
    const next = sampled[index + 1] ?? value;
    const smoothed = (prev + value * 2 + next) / 4;
    return Math.min(1, Math.max(0.04, Number(smoothed.toFixed(3))));
  });
}

/**
 * Столбец «проигран» целиком, если его правый край левее курсора.
 * Так оранжевая часть совпадает с положением пальца, а не отстаёт на столбец.
 */
export function isBarPlayed(index: number, bars: number, progress: number): boolean {
  if (!Number.isFinite(progress) || progress <= 0) return false;
  if (progress >= 1) return true;
  return (index + 1) / bars <= progress;
}

export type BarLayout = { x: number; width: number; height: number; index: number };

/** Раскладка столбцов: ширина зависит от числа баров и доступного места. */
export function layoutBars(width: number, height: number, bars: number, gap = BAR_GAP): BarLayout[] {
  const count = Math.max(1, Math.trunc(bars));
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1;
  const widthPerBar = safeWidth / count;
  const barWidth = Math.max(BAR_MIN_WIDTH, Math.min(BAR_MAX_WIDTH, widthPerBar - gap));

  return Array.from({ length: count }, (_, index) => ({
    index,
    x: index * widthPerBar,
    width: Math.max(1, Math.min(barWidth, widthPerBar)),
    height: safeHeight,
  }));
}

/**
 * Точка, на которую надо прокрутить волну, чтобы играющий столбец был в центре.
 * Возвращает `null`, пока волна целиком помещается в экран (скроллить нечего).
 */
export function waveScrollOffset(
  progress: number,
  bars: number,
  width: number,
  viewport: number,
  gap = BAR_GAP
): number | null {
  if (!Number.isFinite(width) || width <= viewport || bars <= 0) return null;
  const perBar = width / bars;
  const played = Math.min(bars, Math.max(0, progress) * bars);
  // центр экрана минус позиция играющего столбца
  const target = played * perBar - viewport / 2 + perBar / 2;
  return Math.max(0, Math.min(width - viewport, target));
}

/** Время под пальцем: доля → секунды, с защитой от duration = 0. */
export function seekSeconds(fraction: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, Number(fraction) || 0));
  return Math.round(ratio * duration * 10) / 10;
}

/** Крупное время для транспорта: `0:36`, `12:05`, `1:02:09`. */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
