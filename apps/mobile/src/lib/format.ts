/** Мелочи, которые не зависят от React Native — их удобно тестировать в Node. */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 МБ';
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} МБ`;
  return `${(mb / 1024).toFixed(1)} ГБ`;
}

const MIME_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/webm': 'webm',
};

/** Расширение по MIME: AVPlayer/ExoPlayer определяют контейнер по имени файла. */
export function mimeToExt(mime: string | null | undefined): string {
  if (!mime) return 'bin';
  return MIME_EXT[String(mime).toLowerCase().split(';')[0].trim()] ?? 'bin';
}

export function downloadFileName(id: string, mime: string | null | undefined): string {
  return `${id}.${mimeToExt(mime)}`;
}
