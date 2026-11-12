import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { checks, checkUrl, headersFor, judge, networkError, sampleAudio, summarize } from './tester';

const ctx = { base: 'http://127.0.0.1:4000/' };

test('набор проверок покрывает путь файла целиком и убирает за собой', () => {
  const list = checks(ctx);
  assert.deepEqual(list.map((c) => c.id), ['health', 'files', 'upload', 'download', 'range', 'delete']);
  // удаление — последним, иначе загрузка не проверит скачивание
  assert.equal(list.at(-1)?.id, 'delete');
  // проверка перемотки действительно просит диапазон
  assert.equal(list.find((c) => c.id === 'range')?.headers?.Range, 'bytes=0-15');
  // у каждой проверки есть объяснение «зачем»
  for (const spec of list) assert.ok(spec.why.length > 5, `нет why у ${spec.id}`);
});

test('sampleAudio — не пустое тело с ID3-заголовком', () => {
  const body = sampleAudio();
  assert.ok(body.length >= 128);
  assert.equal(String.fromCharCode(...body.slice(0, 3)), 'ID3');
});

test('модуль тестера импортируется в Hermes без глобального TextEncoder', () => {
  const testerModule = new URL('./tester.ts', import.meta.url).href;
  const source = `globalThis.TextEncoder = undefined; await import(${JSON.stringify(testerModule)});`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
});

test('checkUrl не удваивает слэш', () => {
  assert.equal(checkUrl('http://127.0.0.1:4000', { path: '/api/health' } as never), 'http://127.0.0.1:4000/api/health');
  assert.equal(checkUrl('http://127.0.0.1:4000/', { path: '/api/health' } as never), 'http://127.0.0.1:4000/api/health');
  assert.equal(checkUrl('http://127.0.0.1:4000///', { path: '/api/health' } as never), 'http://127.0.0.1:4000/api/health');
});

test('headersFor добавляет токен только когда он есть', () => {
  const spec = checks(ctx).find((c) => c.id === 'range')!;
  assert.deepEqual(headersFor(spec, null), { Range: 'bytes=0-15' });
  assert.deepEqual(headersFor(spec, 'abc'), { Range: 'bytes=0-15', Authorization: 'Bearer abc' });
});

test('judge: успех, неверный код, запрет доступа', () => {
  const health = checks(ctx)[0];
  assert.equal(judge(health, 200, '{"ok":true}', { ok: true }).status, 'ok');
  // 200, но без ok: true — это не здоровье
  assert.match(judge(health, 200, '{}', {}).detail, /ok: true/);
  assert.match(judge(health, 500, 'boom', null).detail, /ошибка сервера 500/);
  assert.match(judge(health, 401, 'unauthorized', null).detail, /токен/);
  assert.match(judge(health, 403, '', null).detail, /токен/);
});

test('judge: Range возвращает 206 и не больше запрошенного', () => {
  const range = checks(ctx).find((c) => c.id === 'range')!;
  assert.equal(judge(range, 206, '16 байт', null).status, 'ok');
  assert.equal(judge(range, 200, 'весь файл целиком и ещё немного', null).status, 'fail');
  // 200 вместо 206 — сервер отдал файл целиком: перемотка работать не будет
  assert.match(judge(range, 200, 'весь файл целиком и ещё немного', null).detail, /ожидался 206/);
  // а если код верный, но тело больше запрошенного — это тоже провал
  assert.match(judge(range, 206, 'x'.repeat(32), null).detail, /вместо 16/);
});

test('summarize считает итог и собирает отчёт', () => {
  const results = [
    { id: 'health', title: 'Сервер отвечает', status: 'ok' as const, http: 200, detail: 'ок' },
    { id: 'files', title: 'Список файлов', status: 'fail' as const, http: 500, detail: 'ошибка сервера 500' },
  ];
  const summary = summarize(results, { url: 'http://127.0.0.1:4000', runtime: 'v24.22.3' });
  assert.equal(summary.total, 2);
  assert.equal(summary.pass, 1);
  assert.equal(summary.fail, 1);
  assert.match(summary.headline, /Проблемы: 1 из 2/);
  assert.match(summary.report, /✓ Сервер отвечает \[200\]/);
  assert.match(summary.report, /✗ Список файлов \[500\]/);
  assert.match(summary.report, /рантайм: v24\.22\.3/);

  const green = summarize([results[0]], { url: 'http://127.0.0.1:4000' });
  assert.match(green.headline, /Все проверки пройдены: 1 из 1/);
  // без рантайма и версии пустых строк в отчёте быть не должно
  assert.equal(green.report.includes('undefined'), false);
});

test('networkError переводит сетевые сбои в человеческий текст', () => {
  assert.match(networkError(new Error('Network request failed')), /не принял соединение/);
  assert.match(networkError(new Error('fetch failed')), /не принял соединение/);
  assert.match(networkError(new Error('timeout of 5000ms exceeded')), /не ответил вовремя/);
  assert.equal(networkError(new Error('странная ошибка')), 'странная ошибка');
  assert.equal(networkError('просто строка'), 'просто строка');
});
