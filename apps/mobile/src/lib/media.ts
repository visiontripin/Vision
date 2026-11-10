/**
 * Какой файл качать на устройство. Логика чистая (без React Native), поэтому
 * покрыта тестами: приоритет — AAC (его понимают и iOS, и Android), затем
 * оригинал, и только потом opus (на iOS ogg ненадёжен).
 */

export type MediaSource = { url: string; mime: string };

export function pickDownloadSource(
  streams: Record<string, string> | undefined,
  trackMime: string | null | undefined,
  fallbackUrl: string | null | undefined
): MediaSource | null {
  if (streams?.aac) return { url: streams.aac, mime: 'audio/mp4' };
  if (streams?.original) return { url: streams.original, mime: trackMime || 'audio/mpeg' };
  if (fallbackUrl) return { url: fallbackUrl, mime: trackMime || 'audio/mpeg' };
  if (streams?.opus) return { url: streams.opus, mime: 'audio/ogg' };
  return null;
}

/** Для воспроизведения стримом — тот же приоритет, но opus допустим на Android. */
export function pickStreamSource(
  streams: Record<string, string> | undefined,
  fallbackUrl: string | null | undefined
): string | null {
  return streams?.aac ?? streams?.original ?? fallbackUrl ?? streams?.opus ?? null;
}
