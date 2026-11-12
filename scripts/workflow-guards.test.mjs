/**
 * Проверки workflow сборки APK — те места, где ошибка не видна локально и стоит
 * либо релиза без функции, либо 10 минут CI.
 *
 * Уже случалось: `if: inputs.embedded != false` на push тега вычислялось в ложь
 * (при push `inputs` — null, а `null != false` в выражениях GitHub неверно),
 * и релизный APK молча вышел без встроенного Node: 23 МБ вместо 90.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

const android = read('.github/workflows/android.yml');
const embedded = read('.github/workflows/android-embedded.yml');

test('встроенный Node включается и по тегу, и по кнопке', () => {
  // при push `inputs` не существует → любое `inputs.x != false` даёт ложь
  assert.equal(
    /inputs\.embedded\s*!=\s*false/.test(android),
    false,
    'условие `inputs.embedded != false` ложно при push тега — Node не попадёт в APK',
  );
  for (const step of ['Встроить сервер в проект', 'Node-рантайм для встроенного сервера']) {
    const index = android.indexOf(step);
    assert.ok(index > 0, `в android.yml нет шага «${step}»`);
    // условие шага — в пределах 200 символов перед `run:`
    const chunk = android.slice(index, index + 200);
    assert.match(chunk, /github\.event_name != 'workflow_dispatch' \|\| inputs\.embedded/, `шаг «${step}» без верного условия`);
  }
});

test('публикация APK не привязана к inputs.release', () => {
  // `inputs.release` на push тега тоже null → релиз не создавался бы, если бы
  // условие опиралось только на него. Допустимая форма — с проверкой тега.
  const uses = [...android.matchAll(/if:.*inputs\.release.*$/gm)].map((m) => m[0]);
  assert.ok(uses.length > 0, 'публикация должна учитывать inputs.release');
  for (const line of uses) {
    assert.match(line, /startsWith\(github\.ref, 'refs\/tags\/android-v'\)/, `условие без проверки тега: ${line}`);
  }
});

test('в workflow есть проверка содержимого APK', () => {
  for (const marker of ['libvisionnode.so', 'bootstrap.mjs', 'VisionNodeService']) {
    assert.ok(android.includes(marker) || embedded.includes(marker), `нигде не проверяется ${marker}`);
  }
  // размер APK печатается: по нему видно, попал ли рантайм
  assert.match(embedded, /размер \$\(du -h/);
});

test('сборка с Node идёт в обоих workflow одинаково', () => {
  for (const file of [android, embedded]) {
    assert.match(file, /scripts\/fetch-nodejs-mobile\.mjs/);
    assert.match(file, /scripts\/android-embed-node\.mjs/);
  }
  // кэш рантайма — по версии, иначе 90 МБ качаются каждый раз
  for (const file of [android, embedded]) {
    assert.match(file, /key: nodejs-mobile-\$\{\{ hashFiles\('apps\/mobile\/nodejs\/android\/node-version\.json'\) \}\}/);
  }
});

test('проверка APK не хардкодит три ABI', () => {
  // Собирается один ABI по умолчанию — проверка должна брать список из проекта,
  // иначе релиз падает на «нет libnode.so для armeabi-v7a».
  for (const file of [android, embedded]) {
    assert.equal(
      /for abi in arm64-v8a armeabi-v7a x86_64/.test(file),
      false,
      'список ABI захардкожен в проверке APK',
    );
    assert.match(file, /ABIS=\$\(grep -E '\^reactNativeArchitectures=' android\/gradle\.properties/);
  }
});

test('ABI по умолчанию — один, чтобы APK не раздувался', () => {
  const script = read('scripts/android-embed-node.mjs');
  assert.match(script, /process\.env\.VISION_ABIS \|\| 'arm64-v8a'/);
});
