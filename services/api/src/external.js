/**
 * Импорт ссылок на внешние треки — без скачивания аудио.
 *
 * Разрешено: официальный oEmbed-эндпоинт SoundCloud (публичный, документированный,
 * отдаёт метаданные и код встраиваемого плеера) и встраивание их плеера в наш UI.
 * Запрещено (и не реализуется): парсинг HTML-страниц, скачивание/кэширование
 * аудио, обход ограничений доступа, проксирование потока через наш сервер.
 *
 * Адрес oEmbed вынесен в env, чтобы тесты не ходили в интернет и чтобы можно было
 * поддержать другие сервисы с тем же протоколом.
 */

const DEFAULT_OEMBED = 'https://soundcloud.com/oembed';
const ALLOWED_HOSTS = new Set([
  'soundcloud.com',
  'www.soundcloud.com',
  'm.soundcloud.com',
  'on.soundcloud.com',
]);

const EMBED_HOSTS = new Set(['w.soundcloud.com']);

export const OEMBED_BASE = process.env.SOUNDCLOUD_OEMBED_BASE || DEFAULT_OEMBED;
const TIMEOUT_MS = Number(process.env.OEMBED_TIMEOUT_MS || 6000);

export class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Проверяет, что это ссылка на публичную страницу SoundCloud, и нормализует её. */
export function normalizePermalink(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw new ImportError('invalid_url', 'Это не похоже на ссылку.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ImportError('invalid_url', 'Нужна http(s)-ссылка.');
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new ImportError('unsupported_host', 'Поддерживаются только ссылки soundcloud.com.');
  }

  const path = url.pathname.replace(/\/+$/, '');
  if (!path || path === '' || path === '/') {
    throw new ImportError('invalid_url', 'Ссылка должна вести на конкретный трек или плейлист.');
  }
  // отбрасываем utm-метки и прочий мусор, чтобы дедупликация работала
  return `https://soundcloud.com${path}`;
}

/** Достаёт src официального виджета из html, который вернул oEmbed. */
export function extractEmbedUrl(html) {
  if (typeof html !== 'string') return null;
  const match = /<iframe[^>]+src="([^"]+)"/i.exec(html);
  if (!match) return null;
  try {
    const url = new URL(match[1].replace(/&amp;/g, '&'));
    if (!EMBED_HOSTS.has(url.hostname.toLowerCase())) return null;
    if (!url.pathname.startsWith('/player')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Резолвит ссылку через oEmbed. Ничего не пишет в БД — чистая функция.
 * Никогда не проксирует аудио: только метаданные.
 */
export async function resolveSoundCloudLink(input, { fetchImpl = fetch } = {}) {
  const permalink = normalizePermalink(input);
  const endpoint = new URL(OEMBED_BASE);
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('url', permalink);
  endpoint.searchParams.set('maxwidth', '640');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'VisionAudio/0.4 (+personal-library)' },
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (error) {
    throw new ImportError(
      'source_unreachable',
      error?.name === 'AbortError'
        ? 'Источник не ответил вовремя. Попробуйте ещё раз.'
        : 'Не удалось связаться с источником.'
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) throw new ImportError('not_found', 'Трек не найден или удалён.');
  if (!response.ok) throw new ImportError('source_error', `Источник ответил ${response.status}.`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ImportError('source_error', 'Источник вернул не JSON.');
  }

  const embedUrl = extractEmbedUrl(payload.html);
  if (!embedUrl) throw new ImportError('embed_unavailable', 'У этого трека нет официального встраивания.');

  const title = String(payload.title || '').trim() || 'Без названия';
  const artist = String(payload.author_name || '').trim() || null;
  const artwork = typeof payload.thumbnail_url === 'string' && /^https:\/\//.test(payload.thumbnail_url)
    ? payload.thumbnail_url
    : null;

  return { permalink, title: title.slice(0, 300), artist: artist && artist.slice(0, 120), artwork, embedUrl };
}
