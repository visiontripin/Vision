/**
 * Логика очереди без React Native: порядок воспроизведения, шаг вперёд/назад,
 * перемешивание. Вынесено отдельно, чтобы покрыть тестами в Node.
 */

export type Repeat = 'off' | 'all' | 'one';

/**
 * Куда перейти по «следующий/предыдущий».
 * `manual` — пользователь нажал кнопку: тогда край очереди заворачивается,
 * даже если повтор выключен (как в вебе). `null` — играть больше нечего.
 */
export function stepPosition(
  position: number,
  length: number,
  repeat: Repeat,
  delta: 1 | -1,
  manual = false
): number | null {
  if (length <= 0) return null;
  const next = position + delta;
  if (next >= 0 && next < length) return next;
  if (manual || repeat === 'all') return delta > 0 ? 0 : length - 1;
  return null;
}

/** Порядок воспроизведения при перемешивании: текущий трек остаётся первым. */
export function shuffleIndices(length: number, first: number, random: () => number = Math.random): number[] {
  if (length <= 0) return [];
  const start = Math.min(Math.max(0, first), length - 1);
  const rest = Array.from({ length }, (_, index) => index).filter((index) => index !== start);
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [start, ...rest];
}

/** Индекс трека в порядке воспроизведения (или -1). */
export function orderIndexOf(order: number[], trackIndex: number): number {
  return order.indexOf(trackIndex);
}

/** Сколько ещё осталось до конца очереди — для подписи в мини-плеере. */
export function remainingCount(position: number, length: number): number {
  return Math.max(0, length - position - 1);
}
