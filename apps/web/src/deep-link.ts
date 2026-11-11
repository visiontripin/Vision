/**
 * Разбор входящих ссылок (F1/F5): deep links `visionaudio://`, хэш-маршруты
 * `#/track/<id>` и данные share target.
 *
 * Почему отдельным модулем без React: ссылки приходят из чужих мест (мессенджер,
 * заметки, системное меню «Поделиться»), и ошибка разбора проявляется как «пустой
 * экран» — самое дорогое для отладки. Здесь всё чисто и под `node --test`.
 *
 * Правила (docs/API.md, «Вход по ссылке и share target»):
 *  - понимаем две формы: схему приложения и обычный URL с хэшем;
 *  - `id` — 32 hex-символа, иначе это не наш трек;
 *  - `t` — только неотрицательные секунды, всё прочее игнорируется;
 *  - непонятная ссылка даёт `null`, а вызывающий код показывает библиотеку с
 *    сообщением, а не пустую страницу.
 */

export type DeepTarget =
  | { kind: 'track'; id: string; at: number | null; autoplay: boolean }
  | { kind: 'playlist'; id: string; autoplay: boolean }
  | { kind: 'share' };

const ID = /^[a-f0-9]{32}$/i;
/** Схема приложения: регистр не важен, `//` после неё — как в документации. */
const SCHEME = /^visionaudio:[/]{0,2}/i;

/** Секунды из строки: отрицательные и мусор → null, огромные клампятся. */
export function parseSeconds(value: unknown, max = 86_400): number | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const seconds = Math.floor(Number(text));
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds, max);
}

/**
 * `visionaudio://track/<id>?t=90` и `#/track/<id>/90` → цель навигации.
 * `null` означает «ссылка не наша или битая» — вызывающий код решает, что показать.
 */
export function parseDeepLink(raw: string, origin = 'visionaudio://'): DeepTarget | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const isScheme = SCHEME.test(text);
  if (!isScheme && !text.startsWith('#') && !text.includes('/track/') && !text.includes('/playlist/')) {
    return null;
  }
  if (isScheme && !text.toLowerCase().startsWith('visionaudio:')) return null;

  /**
   * Приводим всё к http-URL с условным базовым адресом. Именно так, а не через
   * `new URL('visionaudio://track/<id>')`: для нестандартной схемы `track`
   * становится хостом, и путь теряется — ссылка молча превращалась бы в «битую».
   */
  const stub = origin === 'visionaudio://' ? 'http://vision.invalid/' : `${origin.replace(/\/$/, '')}/`;
  const normalised = isScheme ? text.replace(SCHEME, stub) : text.startsWith('#') ? `${stub}${text}` : text;

  let url: URL;
  try {
    url = new URL(normalised, stub);
  } catch {
    return null;
  }

  // путь и хэш равноправны: `#/track/…` и `visionaudio://track/…`
  const path = url.pathname.replace(/^\/+|\/+$/g, '');
  const hashRaw = url.hash.replace(/^#\/?/, '');
  const source = hashRaw || path;
  if (!source) return null;

  const [head, ...rest] = source.split('/');
  const verb = head.toLowerCase();

  if (verb === 'share') return { kind: 'share' };

  if (verb === 'track' || verb === 'play' || verb === 'playlist') {
    const id = rest[0] || '';
    if (!ID.test(id)) return null;
    // `/track/<id>/90` — позиция прямо в пути; `?t=90` приоритетнее
    const fromQuery = parseSeconds(url.searchParams.get('t') ?? url.searchParams.get('start'));
    const fromPath = parseSeconds(rest[1]);
    const at = fromQuery ?? fromPath;

    if (verb === 'playlist') {
      const play = ['1', 'true', 'yes'].includes(String(url.searchParams.get('play') ?? '').toLowerCase());
      return { kind: 'playlist', id: id.toLowerCase(), autoplay: play };
    }
    return {
      kind: 'track',
      id: id.toLowerCase(),
      at,
      autoplay: verb === 'play',
    };
  }

  return null;
}

/**
 * Share target (`/share?url=…&text=…&title=…`) → что предложить загрузить.
 *
 * Ссылку на аудиофайл принимаем как `remote`, любой другой адрес — как `link`
 * (пользователь мог поделиться страницей; врать «это аудио» нельзя). Данные
 * берём из `url`, иначе вытаскиваем первый http-адрес из `text`: Android часто
 * присылает всё в `text`.
 */
export type SharePayload =
  | { kind: 'remote'; url: string; title: string | null }
  | { kind: 'link'; url: string; title: string | null }
  | { kind: 'text'; text: string }
  | { kind: 'empty' };

const AUDIO_EXT = /\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|webm|aiff?|wma)(\?|#|$)/i;

export function parseShareTarget(search: string | URLSearchParams): SharePayload {
  const params = typeof search === 'string' ? new URLSearchParams(search.replace(/^\?/, '')) : search;
  const title = (params.get('title') || '').trim() || null;
  const urlField = (params.get('url') || '').trim();
  const textField = (params.get('text') || '').trim();

  const candidate = urlField || (textField.match(/https?:\/\/\S+/) || [])[0] || '';
  if (candidate) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(candidate);
    } catch {
      parsed = null;
    }
    if (parsed && /^https?:$/.test(parsed.protocol)) {
      const url = parsed.toString();
      return { kind: AUDIO_EXT.test(url) ? 'remote' : 'link', url, title };
    }
  }

  if (textField) return { kind: 'text', text: textField };
  return { kind: 'empty' };
}

/** Обратная операция: ссылка на трек для «Поделиться» и deep link для Android. */
export function trackLink(id: string, origin: string): string {
  return `${String(origin).replace(/\/$/, '')}/#/track/${id.toLowerCase()}`;
}

export function trackDeepLink(id: string, at: number | null = null): string {
  const base = `visionaudio://track/${id.toLowerCase()}`;
  return at && at > 0 ? `${base}?t=${Math.floor(at)}` : base;
}

/**
 * Нужно ли делиться системным диалогом. В установленной PWA и на мобильном —
 * да; в обычном десктопном браузере `navigator.share` есть не всегда, поэтому
 * вызывающий код падает обратно на копирование.
 */
export function canNativeShare(scope: {
  hasNavigatorShare?: boolean;
  maxTouchPoints?: number;
  userAgent?: string;
} = {}): boolean {
  if (!scope.hasNavigatorShare) return false;
  const ua = String(scope.userAgent || '').toLowerCase();
  // на десктопе Windows/Linux share-диалога обычно нет: копирование предсказуемее
  if (/windows nt|linux x86|cros/.test(ua)) return false;
  return true;
}
