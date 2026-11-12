/**
 * Разбор ссылок для «Добавить по ссылке» (чистая логика, без React Native).
 *
 * Держим отдельно от экрана: адреса приходят из чужих страниц, и «не распознали
 * звук» — самый дорогой баг здесь. Так это можно проверить в Node.
 */

/** Прямые аудио-адреса: их можно сохранить без страницы. */
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|flac|wav)(\?|$)/i;

/** Заведомо не звук: реклама, аналитика, картинки. */
const NOISE = /\.(png|jpe?g|gif|webp|svg|ico|css|js|woff2?|ttf|json)(\?|$)/i;

export function looksLikeAudio(url: string): boolean {
  return AUDIO_EXT.test(String(url ?? '')) && !NOISE.test(String(url ?? ''));
}

/**
 * Из адреса страницы делаем понятное название.
 *
 * `+` в URL — это пробел (`a+b.mp3`), иначе название выглядит как «a+b». Тире
 * сохраняем, подчёркивания превращаем в пробелы: из `my_track-01` получается
 * «my track-01», а не «my track 01» — тире чаще часть названия, чем мусор.
 */
export function titleFromUrl(raw: string): string {
  const cleaned = (value: string) =>
    value
      .replace(AUDIO_EXT, '')
      .replace(/[_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  try {
    const url = new URL(String(raw ?? '').trim());
    const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
    let decoded = last;
    try {
      decoded = decodeURIComponent(last);
    } catch {
      /* битая кодировка — работаем как есть */
    }
    return cleaned(decoded.replace(/\+/g, ' ')) || url.hostname;
  } catch {
    return cleaned(String(raw ?? '').replace(/\+/g, ' ')).slice(0, 60) || 'Трек по ссылке';
  }
}

/**
 * Скрипт-перехватчик внутри страницы.
 *
 * Отправляет найденные адреса в React Native через `postMessage`. Ничего не
 * блокирует и не подменяет: страница работает как обычно, а мы лишь слушаем.
 */
export const HOOK_SCRIPT = `
(function () {
  if (window.__visionHooked) return;
  window.__visionHooked = true;
  var seen = {};
  function report(url, kind) {
    try {
      if (!url || typeof url !== 'string') return;
      if (!/^https?:/i.test(url)) return;
      if (/\\.(png|jpe?g|gif|webp|svg|ico|css|js|woff2?|ttf|json)(\\?|$)/i.test(url)) return;
      if (seen[url]) return;
      seen[url] = true;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: kind, url: url }));
    } catch (e) {}
  }
  var open = window.XMLHttpRequest && window.XMLHttpRequest.prototype.open;
  if (open) {
    window.XMLHttpRequest.prototype.open = function (method, url) {
      report(url, 'xhr');
      return open.apply(this, arguments);
    };
  }
  if (window.fetch) {
    var original = window.fetch;
    window.fetch = function (input) {
      try { report(typeof input === 'string' ? input : (input && input.url), 'fetch'); } catch (e) {}
      return original.apply(this, arguments);
    };
  }
  document.addEventListener('play', function (event) {
    var el = event.target;
    if (el && el.currentSrc) report(el.currentSrc, 'media');
  }, true);
  document.addEventListener('loadedmetadata', function (event) {
    var el = event.target;
    if (el && el.currentSrc) report(el.currentSrc, 'media');
  }, true);
  setInterval(function () {
    var list = document.querySelectorAll('audio, video');
    for (var i = 0; i < list.length; i++) {
      if (list[i].currentSrc) report(list[i].currentSrc, 'media');
    }
  }, 1500);
  true;
})();
true;
`;
