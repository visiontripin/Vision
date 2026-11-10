/**
 * Чтение ZIP без зависимостей: разбираем центральный каталог сами, а распаковку
 * deflate отдаём встроенному `DecompressionStream('deflate-raw')`.
 *
 * Зачем: массовый импорт архива с музыкой. Поддержаны методы store (0) и
 * deflate (8) — этого достаточно для архивов из Finder, Explorer и `zip -r`.
 * ZIP64 и зашифрованные архивы пропускаются, а не валят весь импорт.
 */

export type ZipEntry = {
  /** путь внутри архива (может содержать папки) */
  name: string;
  /** 0 — store, 8 — deflate */
  method: number;
  compressedSize: number;
  size: number;
  /** абсолютный offset данных в буфере архива */
  dataOffset: number;
  flags: number;
};

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_ENTRY_BYTES = 500 * 1024 * 1024; // сервер всё равно отклонит больше

const textDecoder = new TextDecoder('utf-8');

function decodeName(bytes: Uint8Array, flags: number): string {
  // бит 11 — имя в UTF-8. Старые архивы пишут в кодировке системы: пробуем UTF-8,
  // при явных «кракозябрах» откатываемся на latin1.
  if (flags & 0x800) return textDecoder.decode(bytes);
  const utf8 = textDecoder.decode(bytes);
  if (!utf8.includes('\uFFFD')) return utf8;
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** Разбирает центральный каталог архива. Бросает, если это не ZIP. */
export function readZipDirectory(buffer: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buffer);
  const length = buffer.byteLength;
  if (length < 22) throw new Error('Это не ZIP-архив.');

  let eocd = -1;
  const minPos = Math.max(0, length - 22 - 0xffff);
  for (let i = length - 22; i >= minPos; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Не найден конец ZIP-архива — файл повреждён.');

  const total = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset <= 0 || cdOffset >= length) throw new Error('Повреждён каталог ZIP-архива.');

  const entries: ZipEntry[] = [];
  let pos = cdOffset;

  for (let index = 0; index < total; index += 1) {
    if (pos + 46 > length || view.getUint32(pos, true) !== CD_SIG) {
      throw new Error('Повреждён список файлов в архиве.');
    }

    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);

    if (pos + 46 + nameLen > length) throw new Error('Повреждённое имя файла в архиве.');
    const name = decodeName(new Uint8Array(buffer, pos + 46, nameLen), flags);
    pos += 46 + nameLen + extraLen + commentLen;

    if (!name || name.endsWith('/')) continue; // папка
    if (flags & 0x1) continue; // зашифровано
    if (compressedSize === 0xffffffff || size === 0xffffffff) continue; // ZIP64
    if (size > MAX_ENTRY_BYTES) continue;
    if (localOffset + 30 > length) continue;
    if (view.getUint32(localOffset, true) !== LOCAL_SIG) continue;

    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
    if (dataOffset + compressedSize > length) continue;

    entries.push({ name, method, compressedSize, size, dataOffset, flags });
  }

  return entries;
}

/** Достаёт один файл архива. Поддерживает store и deflate. */
export async function readZipEntry(buffer: ArrayBuffer, entry: ZipEntry): Promise<Blob> {
  const bytes = new Uint8Array(buffer, entry.dataOffset, entry.compressedSize);

  if (entry.method === 0) return new Blob([bytes]);
  if (entry.method === 8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Браузер не умеет распаковывать deflate.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).blob();
  }
  throw new Error(`Сжатие ZIP методом ${entry.method} не поддерживается.`);
}

export const AUDIO_EXT = /\.(mp3|wav|flac|ogg|oga|opus|m4a|aac|aiff|aif)$/i;

export const isAudioName = (name: string) => AUDIO_EXT.test(name);

export const baseName = (path: string) => path.split('/').pop() || path;

/** Служебный мусор macOS и скрытые файлы. */
export const isJunkPath = (name: string) =>
  name.startsWith('__MACOSX/') || baseName(name).startsWith('._') || baseName(name).startsWith('.');

export const isZipFile = (file: File) =>
  /\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';

/**
 * Папка «Artist - Album» подсказывает исполнителя. Одиночное имя папки не
 * используем: это чаще название альбома, чем артист, и угадывание вредит.
 */
function guessArtistFromPath(dir: string): string | null {
  if (!dir) return null;
  const segment = dir.split('/').filter(Boolean).pop();
  if (!segment) return null;
  const clean = segment.replace(/_/g, ' ').trim();
  const parts = clean.split(/\s+-\s+/);
  if (parts.length < 2) return null;
  const first = (parts[0] || '').trim();
  if (!first || /^\d/.test(first)) return null;
  return first.slice(0, 120);
}

/** Разворачивает архив в список аудиофайлов, годных к загрузке. */
export async function extractAudioFromZip(
  file: File,
  options: { limit?: number } = {}
): Promise<{
  files: File[];
  skipped: number;
  truncated: boolean;
  /** подсказка исполнителя из пути: «Artist - Album/01 - Track.mp3» */
  artistHints: Record<string, string>;
}> {
  const limit = options.limit ?? 2000;
  const buffer = await file.arrayBuffer();
  const entries = readZipDirectory(buffer);

  const files: File[] = [];
  const artistHints: Record<string, string> = {};
  let skipped = 0;

  for (const entry of entries) {
    if (files.length >= limit) return { files, skipped, truncated: true, artistHints };
    if (isJunkPath(entry.name) || !isAudioName(entry.name)) {
      skipped += 1;
      continue;
    }
    try {
      const blob = await readZipEntry(buffer, entry);
      const name = baseName(entry.name);
      files.push(
        new File([blob], name, {
          type: blob.type && blob.type !== 'application/octet-stream' ? blob.type : 'application/octet-stream',
          lastModified: Date.now(),
        })
      );

      const directory = entry.name.split('/').slice(0, -1).join('/');
      const hint = guessArtistFromPath(directory);
      if (hint) artistHints[name] = hint;
    } catch {
      skipped += 1;
    }
  }

  return { files, skipped, truncated: false, artistHints };
}
