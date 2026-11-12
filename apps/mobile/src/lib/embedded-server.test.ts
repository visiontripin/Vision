import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PORT,
  EMPTY_STATUS,
  MAX_PORT_OFFSET,
  describeStatus,
  failureAction,
  isHealthy,
  isReachable,
  libraryMode,
  nextPort,
  parsePort,
  parseServerState,
  runtimeFromState,
  serverUrl,
  summaryLine,
  type ServerStatus,
} from './embedded-server';

const status = (patch: Partial<ServerStatus> = {}): ServerStatus => ({ ...EMPTY_STATUS, ...patch });

test('адрес сервера — IPv4-петля, а не localhost', () => {
  assert.equal(serverUrl(), 'http://127.0.0.1:4000');
  assert.equal(serverUrl(4003), 'http://127.0.0.1:4003');
  assert.equal(DEFAULT_PORT, 4000);
});

test('parsePort разбирает адреса и молчит на мусоре', () => {
  assert.equal(parsePort('http://127.0.0.1:4000'), 4000);
  assert.equal(parsePort('http://127.0.0.1:4010/api/health'), 4010);
  assert.equal(parsePort('http://192.168.1.5:4000'), 4000);
  assert.equal(parsePort('http://example.com'), 80);
  assert.equal(parsePort('https://example.com'), 80);
  assert.equal(parsePort('не адрес'), null);
  assert.equal(parsePort(''), null);
  assert.equal(parsePort(null), null);
  assert.equal(parsePort('http://host:99999'), null);
});

test('nextPort идёт по порядку и упирается в предел', () => {
  assert.equal(nextPort([]), 4000);
  assert.equal(nextPort([4000]), 4001);
  assert.equal(nextPort([4000, 4001, 4003]), 4002);
  const all = Array.from({ length: MAX_PORT_OFFSET + 1 }, (_, i) => DEFAULT_PORT + i);
  assert.equal(nextPort(all), null);
  // свой стартовый порт уважается
  assert.equal(nextPort([5000], 5000), 5001);
});

test('EADDRINUSE лечится сменой порта, остальное — нет', () => {
  assert.equal(failureAction('listen EADDRINUSE: address already in use 127.0.0.1:4000', 1), 'retry');
  assert.equal(failureAction('Error: address already in use', 2), 'retry');
  assert.equal(failureAction('Cannot find module ./server.mjs', 1), 'give-up');
  assert.equal(failureAction('ENOENT: no such file', 1), 'give-up');
  assert.equal(failureAction(null, 1), 'give-up');
  // попытки кончились — сдаёмся, даже если причина «лечимая»
  assert.equal(failureAction('EADDRINUSE', MAX_PORT_OFFSET + 2), 'give-up');
});

test('isHealthy принимает оба контракта ответа', () => {
  assert.equal(isHealthy({ ok: true }), true);
  assert.equal(isHealthy({ status: 'ok', version: '0.9.0' }), true);
  assert.equal(isHealthy({ ok: false }), false);
  assert.equal(isHealthy(null), false);
  assert.equal(isHealthy('ok'), false);
});

test('isReachable — только у работающего сервера с адресом', () => {
  assert.equal(isReachable(status({ phase: 'running', url: serverUrl() })), true);
  assert.equal(isReachable(status({ phase: 'running', url: null })), false);
  assert.equal(isReachable(status({ phase: 'starting', url: serverUrl() })), false);
});

test('describeStatus объясняет каждое состояние человеку', () => {
  assert.match(describeStatus(status({ phase: 'running', url: serverUrl(), runtime: 'v24.22.3' })).detail, /127\.0\.0\.1:4000 · v24\.22\.3/);
  assert.match(describeStatus(status({ phase: 'failed', error: 'EADDRINUSE' })).detail, /EADDRINUSE/);
  assert.match(describeStatus(status({ phase: 'unavailable' })).detail, /без рантайма/);
  assert.equal(describeStatus(status({ phase: 'stopped' })).title, 'Сервер остановлен');
  // «не запустился» без причины не должно печатать пустоту
  assert.match(describeStatus(status({ phase: 'failed', error: null })).detail, /неизвестна/);
});

test('summaryLine собирается в одну строку без лишних разделителей', () => {
  assert.equal(summaryLine({ phase: 'running', url: serverUrl(), runtime: 'v24.22.3', version: '0.9.0' }),
    'running · http://127.0.0.1:4000 · v24.22.3 · v0.9.0');
  assert.equal(summaryLine({ phase: 'stopped', url: null, runtime: null }), 'stopped · без адреса');
});

test('общая библиотека не выключается при поднятом сервере', () => {
  const running = status({ phase: 'running', url: serverUrl() });
  assert.match(libraryMode(running, true), /общая библиотека \+ сервер на телефоне/);
  assert.match(libraryMode(status(), true), /общая библиотека \(реестр\)/);
  // без реестра честно пишем, что устройство одно
  assert.match(libraryMode(running, false), /только этот телефон: сервер поднят/);
  assert.match(libraryMode(status(), false), /только этот телефон$/);
});

test('parseServerState читает state.json и не падает на мусоре', () => {
  const raw = JSON.stringify({ phase: 'running', error: null, runtime: 'v24.22.3', port: 4000 });
  assert.deepEqual(parseServerState(raw), {
    phase: 'running', error: null, runtime: 'v24.22.3', port: 4000, url: null, at: null,
  });
  assert.deepEqual(parseServerState(JSON.stringify({ phase: 'failed', error: 'EADDRINUSE' })), {
    phase: 'failed', error: 'EADDRINUSE', runtime: null, port: null, url: null, at: null,
  });
  // файла ещё нет / он битый — состояния нет, а не «сервер работает»
  assert.equal(parseServerState(null), null);
  assert.equal(parseServerState(''), null);
  assert.equal(parseServerState('{не json'), null);
  assert.equal(parseServerState('null'), parseServerState('null'));
});

test('runtimeFromState берёт только непустую строку', () => {
  assert.equal(runtimeFromState({ runtime: 'v24.22.3' }), 'v24.22.3');
  assert.equal(runtimeFromState({ runtime: '  ' }), null);
  assert.equal(runtimeFromState({ runtime: 42 }), null);
  assert.equal(runtimeFromState(null), null);
});
