/**
 * Входящие ссылки мобильного приложения (F5).
 *
 * Та же схема, что в вебе (`apps/web/src/deep-link.ts`), но здесь только то, что
 * реально приходит в `Intent` на Android/iOS: `visionaudio://…` и `https://…#/…`.
 * Держим отдельной чистой функцией — ссылки приходят из чужих приложений, и
 * «ничего не произошло» тут самый дорогой баг.
 */

export type MobileTarget =
  | { kind: 'track'; id: string; at: number | null; autoplay: boolean }
  | { kind: 'playlist'; id: string; autoplay: boolean }
  | { kind: 'share' };

const ID = /^[a-f0-9]{32}$/i;
const SCHEME = /^visionaudio:[/]{0,2}/i;

export function parseIncoming(raw: string | null | undefined): MobileTarget | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const isScheme = SCHEME.test(text);
  const stub = 'http://vision.invalid/';
  const normalised = isScheme ? text.replace(SCHEME, stub) : text;

  let url: URL;
  try {
    // как и в вебе: для схемы подставляем http-базу, иначе первый сегмент
    // становится хостом и путь теряется
    url = new URL(normalised, stub);
  } catch {
    return null;
  }

  const hashRaw = url.hash.replace(/^#\/?/, '');
  const path = url.pathname.replace(/^\/+|\/+$/g, '');
  const source = hashRaw || path;
  if (!source) return null;

  const [head, ...rest] = source.split('/');
  const verb = head.toLowerCase();
  if (verb === 'share') return { kind: 'share' };
  if (!['track', 'play', 'playlist'].includes(verb)) return null;

  const id = rest[0] || '';
  if (!ID.test(id)) return null;

  const at = parsePosition(url.searchParams.get('t') ?? url.searchParams.get('start') ?? rest[1]);

  if (verb === 'playlist') {
    const play = ['1', 'true', 'yes'].includes(String(url.searchParams.get('play') || '').toLowerCase());
    return { kind: 'playlist', id: id.toLowerCase(), autoplay: play };
  }
  return { kind: 'track', id: id.toLowerCase(), at, autoplay: verb === 'play' };
}

/** Секунды: мусор и минус → null; слишком большие ограничиваем сутками. */
export function parsePosition(value: unknown, max = 86_400): number | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const seconds = Math.floor(Number(text));
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds, max);
}

/**
 * Что делать с входящим `Intent`, который не является deep link: Android
 * присылает «Поделиться» как `ACTION_SEND` с `content://`-адресом файла или
 * текстом. Возвращаем намерение, а решение принимает экран загрузки.
 */
export type IncomingShare =
  | { kind: 'audio'; uri: string; mime: string | null }
  | { kind: 'text'; text: string }
  | null;

export function parseSharedIntent(intent: {
  action?: string | null;
  type?: string | null;
  data?: string | null;
  text?: string | null;
} | null | undefined): IncomingShare {
  if (!intent) return null;
  const data = String(intent.data || '').trim();
  const type = String(intent.type || '').trim() || null;
  const action = String(intent.action || '').toUpperCase();

  if (data && (type?.startsWith('audio/') || /\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i.test(data))) {
    return { kind: 'audio', uri: data, mime: type };
  }
  const text = String(intent.text || '').trim();
  if (text) return { kind: 'text', text };
  if (action === 'SEND' && data) return { kind: 'text', text: data };
  return null;
}
