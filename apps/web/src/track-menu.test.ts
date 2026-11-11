import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Меню действий с треком должно быть видно целиком.
 *
 * Реальный баг (нашли на телефоне): тап по «⋯» не раскрывал меню. Причин было
 * две, и обе — про то, где меню живёт:
 *   1) `.tracklist` имеет `overflow: hidden`, а меню рисовалось абсолютным
 *      блоком ВНУТРИ строки и уходило ниже её границы → оставалась полоска;
 *   2) `z-index: 40` ниже панели плеера (50) → у нижних треков меню оказалось
 *      бы под панелью.
 *
 * Поэтому меню рендерится порталом в `body`, позиционируется от кнопки и лежит
 * выше плеера. Тест сторожит именно эти три свойства: убрать портал, опустить
 * z-index или вернуть вложенный `position: absolute` — и он падает.
 */

const root = path.resolve(import.meta.dirname, '..');

const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

/** Вырезает блок правила из CSS по селектору (первое вхождение). */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `в styles.css нет правила ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

const zIndexOf = (block: string) => Number(/z-index:\s*(\d+)/.exec(block)?.[1] ?? 0);

test('меню трека рендерится порталом в body', () => {
  const source = read('src/components/TrackList.tsx');

  assert.match(source, /import \{ createPortal \} from 'react-dom'/, 'нужен портал');
  assert.match(source, /createPortal\(\s*</, 'меню должно рендериться через портал');
  assert.match(source, /document\.body\s*\)/, 'портал — именно в document.body');
});

test('меню не остаётся внутри списка с overflow: hidden', () => {
  const source = read('src/components/TrackList.tsx');
  const wrapper = source.slice(
    source.indexOf('<div className="track__menuWrap">'),
    source.indexOf('<div className="track__menuWrap">') + 400
  );

  // Внутри обёртки не должно быть самого меню: только кнопка. Иначе вернётся
  // обрезка `overflow: hidden` у `.tracklist`.
  assert.doesNotMatch(wrapper, /className="menu"/, 'меню не должно быть вложено в строку трека');
  assert.match(source, /className="menu menu--floating"/, 'меню позиционируется отдельным слоем');
});

test('позиция меню считается от кнопки и переворачивается вверх', () => {
  const source = read('src/components/TrackList.tsx');

  assert.match(source, /getBoundingClientRect\(\)/, 'координаты берутся у кнопки, а не у строки');
  assert.match(source, /rect\.top - height/, 'если снизу не хватает места — раскрываем вверх');
  assert.match(source, /window\.innerHeight/, 'высота экрана учитывается');
  assert.match(source, /addEventListener\('scroll'/, 'при скролле меню следует за кнопкой');
});

test('плавающее меню выше панели плеера и не шире экрана', () => {
  const css = read('src/styles.css');
  const floating = rule(css, '.menu--floating'); // слой поверх всего

  const player = rule(css, '.player');
  const np = rule(css, '.np');

  assert.match(floating, /position: fixed/, 'меню позиционируется в координатах экрана');
  assert.ok(
    zIndexOf(floating) > zIndexOf(player),
    `меню (${zIndexOf(floating)}) должно быть выше панели плеера (${zIndexOf(player)})`
  );
  // Полный экран плеера — отдельный слой; меню в нём не открывается, но пусть
  // порядок слоёв будет зафиксирован, чтобы не спорить с ним по z-index.
  assert.ok(zIndexOf(floating) >= zIndexOf(np), 'меню не должно уходить под полный экран плеера');
  assert.match(floating, /max-height/, 'высота ограничена, иначе меню выше экрана');
  assert.match(floating, /calc\(100vw - 16px\)/, 'ширина не должна вылезать за экран телефона');
});
