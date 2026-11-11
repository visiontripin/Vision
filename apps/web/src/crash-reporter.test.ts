import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrashReporter } from '@vision/shared';

/**
 * Клиентский репортер падений (H5).
 *
 * Главное свойство: репортер **не имеет права** ломать приложение и не имеет
 * права зацикливаться. Поэтому проверяем не «отчёт ушёл», а поведение на
 * отказах: сети нет, сервер отвечает 500, очередь переполнена, тот же баг
 * повторяется двадцать раз.
 */

type Sent = { url: string; body: string; headers: Record<string, string> };

/** Подменяем fetch на время теста: настоящая сеть в тестах не нужна. */
function withFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response, run: () => Promise<void> | void) {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    sent.push({ url: String(url), body: String(init.body ?? ''), headers: (init.headers ?? {}) as Record<string, string> });
    return handler(String(url), init);
  }) as typeof fetch;
  const restore = () => {
    globalThis.fetch = original;
  };
  const result = run();
  if (result instanceof Promise) return result.finally(restore).then(() => sent);
  restore();
  return Promise.resolve(sent);
}

const ok = () => new Response('{"accepted":true}', { status: 200, headers: { 'content-type': 'application/json' } });

test('падение отправляется на /api/crashes с версией и платформой', async () => {
  const reporter = createCrashReporter(() => 'http://192.168.1.10:4000', {
    app: 'mobile',
    version: '0.5.0',
    platform: 'android',
    release: '34',
    deviceId: 'phone-1',
    context: () => ({ screen: 'library' }),
  });

  const sent = await withFetch(ok, async () => {
    reporter.capture(new TypeError('undefined is not a function'));
    await reporter.flush();
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'http://192.168.1.10:4000/api/crashes');
  const body = JSON.parse(sent[0].body);
  assert.equal(body.app, 'mobile');
  assert.equal(body.version, '0.5.0');
  assert.equal(body.platform, 'android');
  assert.equal(body.name, 'TypeError');
  assert.deepEqual(body.context, { screen: 'library' });
  assert.equal(reporter.queued(), 0);
});

test('сеть недоступна: отчёт остаётся в очереди, а не теряется', async () => {
  const reporter = createCrashReporter(() => 'http://nohost:4000', { app: 'mobile', version: '0.5.0' });

  await withFetch(() => Promise.reject(new Error('ECONNREFUSED')), async () => {
    reporter.capture(new Error('boom'));
    await reporter.flush();
  });
  assert.equal(reporter.queued(), 1, 'отчёт ждёт сети');

  // сеть вернулась — отчёт уходит со следующей попыткой
  const sent = await withFetch(ok, async () => {
    await reporter.flush();
  });
  assert.equal(sent.length, 1);
  assert.equal(reporter.queued(), 0);
});

test('пустой адрес сервера: не отправляем и не падаем', async () => {
  const reporter = createCrashReporter(() => '', { app: 'mobile' });
  await withFetch(ok, async () => {
    reporter.capture(new Error('no base'));
    await reporter.flush();
  });
  assert.equal(reporter.queued(), 1);
});

test('очередь схлопывает одинаковые падения: сломанный цикл не заливает сервер', async () => {
  const reporter = createCrashReporter(() => 'http://h:1', { app: 'mobile', queueLimit: 5 });
  await withFetch(() => Promise.reject(new Error('нет сети')), async () => {
    for (let i = 0; i < 20; i += 1) {
      reporter.capture(new Error('одинаковый рендер'));
      await reporter.flush();
    }
  });
  assert.equal(reporter.queued(), 1, 'двадцать одинаковых — один отчёт');
});

test('разные падения держатся до лимита, старые вытесняются', async () => {
  const reporter = createCrashReporter(() => 'http://h:1', { app: 'mobile', queueLimit: 2 });
  await withFetch(() => Promise.reject(new Error('нет сети')), async () => {
    reporter.capture(new Error('первое'));
    reporter.capture(new Error('второе'));
    reporter.capture(new Error('третье'));
    await reporter.flush();
  });
  assert.equal(reporter.queued(), 2, 'лимит соблюдается');
});

test('500 от сервера: отчёт остаётся; 4xx — отчёт плохой, не повторяем', async () => {
  const failing = createCrashReporter(() => 'http://h:1', { app: 'mobile' });
  await withFetch(() => new Response('{"error":{}}', { status: 500 }), async () => {
    failing.capture(new Error('сервер болен'));
    await failing.flush();
  });
  assert.equal(failing.queued(), 1);

  const bad = createCrashReporter(() => 'http://h:1', { app: 'mobile' });
  await withFetch(() => new Response('{"error":{"code":"invalid_json"}}', { status: 400 }), async () => {
    bad.capture(new Error('плохой отчёт'));
    await bad.flush();
  });
  assert.equal(bad.queued(), 0, '400 — повторять бессмысленно');
});

test('репортер не падает от мусора в ошибке и в контексте', async () => {
  const reporter = createCrashReporter(() => 'http://h:1', {
    app: 'mobile',
    context: () => {
      throw new Error('контекст сломался');
    },
  });
  const sent = await withFetch(ok, async () => {
    reporter.capture('строка вместо ошибки');
    reporter.capture({ weird: true });
    await reporter.flush();
  });
  assert.equal(sent.length, 2);
  const body = JSON.parse(sent[0].body);
  assert.equal(body.message, 'строка вместо ошибки');
  assert.deepEqual(body.context, {});
});
