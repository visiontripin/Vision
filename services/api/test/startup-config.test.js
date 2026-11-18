import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDefaultListenerHost, inspectListenerConfig, isLoopbackHost } from '../src/startup-config.js';
import { assertFts5Available } from '../src/runtime-checks.js';

test('development starts loopback-only while production keeps explicit network mode', () => {
  const development = { NODE_ENV: 'development' };
  assert.equal(applyDefaultListenerHost(development), '127.0.0.1');

  const production = { NODE_ENV: 'production' };
  assert.equal(applyDefaultListenerHost(production), '0.0.0.0');

  const explicit = { NODE_ENV: 'development', HOST: '192.168.1.20' };
  assert.equal(applyDefaultListenerHost(explicit), '192.168.1.20');
});

test('listener safety recognizes loopback addresses only', () => {
  for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['0.0.0.0', '192.168.1.10', '127.0.0.256', 'example.test']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test('network bind requires an explicit password or password file', () => {
  const denied = inspectListenerConfig({ HOST: '0.0.0.0' });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /VISION_PASSWORD/);

  assert.equal(inspectListenerConfig({ HOST: '0.0.0.0', VISION_PASSWORD: 'random-secret' }).ok, true);
  assert.equal(inspectListenerConfig({ HOST: '0.0.0.0', VISION_PASSWORD_FILE: '/private/owner-auth.json' }).ok, true);

  const local = inspectListenerConfig({ HOST: '127.0.0.1' });
  assert.equal(local.ok, true);
  assert.match(local.warning, /legacy default owner password/i);
});

test('FTS5 startup preflight succeeds on the supported runtime', () => {
  assert.doesNotThrow(() => assertFts5Available());
});

test('FTS5 startup preflight explains builds missing the extension', () => {
  class SQLiteWithoutFts5 {
    exec() {
      throw new Error('no such module: fts5');
    }

    close() {}
  }

  assert.throws(
    () => assertFts5Available(SQLiteWithoutFts5),
    /requires SQLite FTS5.*Node\.js 22\.16\.0 or newer.*no such module: fts5/,
  );
});
