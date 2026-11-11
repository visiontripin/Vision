import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Оверлеи не должны рендериться внутри панели плеера.
 *
 * Реальный баг (нашёлся на телефоне в браузере): полноэкранный плеер
 * разворачивался не на весь экран, а на высоту нижней панели. Причина не в CSS
 * самого оверлея, а в родителе: у `.player` стоит `backdrop-filter: blur(24px)`,
 * а `backdrop-filter` (как `filter` и `transform`) делает элемент containing
 * block для `position: fixed` — `inset: 0` отсчитывался от панели.
 *
 * Тест дешёвый, но ловит именно эту регрессию: в исходнике полноэкранного
 * плеера обязателен портал в `document.body`, а у контейнера панели не должно
 * появляться `position: relative`/`transform` — это вернуло бы баг другим путём.
 */

const root = path.resolve(import.meta.dirname, '..');

const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

test('полноэкранный плеер рендерится порталом в body', () => {
  const source = read('src/components/NowPlaying.tsx');

  assert.match(source, /createPortal\(/, 'плеер должен рендериться через портал');
  assert.match(source, /createPortal\(content, document\.body\)/, 'портал — именно в document.body');
  // Свойство должно быть в коде, а не только в комментарии: иначе следующий
  // рефакторинг вернёт обычный return и никто не заметит.
  assert.match(source, /return createPortal/, 'возврат из компонента — портал, а не голый JSX');
});

test('у панели плеера backdrop-filter объяснён, а не «просто так»', () => {
  const css = read('src/styles.css');
  const playerBlock = css.slice(css.indexOf('.player {'), css.indexOf('.player__nowWrap'));
  assert.match(playerBlock, /backdrop-filter/, 'панель по-прежнему размывает фон');
  assert.match(css, /containing block/, 'в CSS должно быть объяснение, почему оверлеи не вкладывают в панель');
});

test('оверлеи объявлены fixed с inset 0 и лежат выше панели', () => {
  const css = read('src/styles.css');
  const np = css.slice(css.indexOf('.np {'), css.indexOf('.np__backdrop'));
  assert.match(np, /position: fixed/);
  assert.match(np, /inset: 0/);
  const zIndex = Number(/z-index:\s*(\d+)/.exec(np)?.[1] ?? 0);
  const playerZ = Number(/z-index:\s*(\d+)/.exec(css.slice(css.indexOf('.player {')))?.[1] ?? 0);
  assert.ok(zIndex > playerZ, `оверлей (${zIndex}) должен быть выше панели (${playerZ})`);
});
