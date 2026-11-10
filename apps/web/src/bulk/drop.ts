/**
 * Перетаскивание папок: DataTransfer.files содержит только файлы, а каталоги
 * доступны через webkitGetAsEntry. Рекурсивно обходим дерево (readEntries
 * отдаёт не больше 100 записей за вызов — поэтому цикл).
 */

type FileEntryLike = {
  isFile: boolean;
  isDirectory: boolean;
  file?: (onSuccess: (file: File) => void, onError?: (error: unknown) => void) => void;
  createReader?: () => {
    readEntries: (onSuccess: (entries: FileEntryLike[]) => void, onError?: (error: unknown) => void) => void;
  };
};

async function walk(entry: FileEntryLike, out: File[], depth = 0): Promise<void> {
  if (depth > 20) return;

  if (entry.isFile && entry.file) {
    await new Promise<void>((resolve) => {
      entry.file?.(
        (file) => {
          out.push(file);
          resolve();
        },
        () => resolve()
      );
    });
    return;
  }

  if (!entry.isDirectory || !entry.createReader) return;
  const reader = entry.createReader();

  // readEntries отдаёт пачками, пока не вернёт пустой массив
  for (;;) {
    const batch = await new Promise<FileEntryLike[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]));
    });
    if (!batch.length) break;
    for (const child of batch) await walk(child, out, depth + 1);
  }
}

/** Возвращает плоский список файлов из drag&drop (включая содержимое папок). */
export async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .map((entry) => entry as unknown as FileEntryLike);

  if (!entries.length) return Array.from(dataTransfer.files);

  const out: File[] = [];
  for (const entry of entries) await walk(entry, out);
  return out;
}
