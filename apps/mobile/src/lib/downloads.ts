/**
 * Поиск копии в индексе скачанных файлов.
 *
 * Копия на телефоне — это блоб: она адресуется `sha256` содержимого, а `id` трека
 * лишь подпись строки в библиотеке. Поэтому один и тот же файл, импортированный
 * заново (новый `id`) или пришедший с другого узла, находится по хешу и не
 * качается второй раз.
 */

export type IndexedCopy = { id: string; hash?: string };

/** Запись о копии по id трека или по `sha256`. null — копии нет. */
export function findCopy<T extends IndexedCopy>(
  entries: Record<string, T>,
  ref: string | null | undefined
): T | null {
  if (!ref) return null;
  const direct = entries[ref];
  if (direct) return direct;
  const hash = ref.trim();
  if (!hash) return null;
  for (const entry of Object.values(entries)) {
    if (entry.hash === hash) return entry;
  }
  return null;
}
