import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPlatformServerConfig } from '../src/platform/config.js';

test('platform server defaults to loopback and keeps registration disabled', () => {
  assert.deepEqual(getPlatformServerConfig({}), {
    host: '127.0.0.1',
    port: 4400,
    registrationEnabled: false,
    uploadsEnabled: false,
    maxUploadBytes: 209715200,
  });
});

test('platform server honors explicit interface, port, and registration opt-in', () => {
  assert.deepEqual(getPlatformServerConfig({
    PLATFORM_HOST: '0.0.0.0',
    PLATFORM_PORT: '4500',
    PLATFORM_REGISTRATION_ENABLED: '1',
    PLATFORM_UPLOADS_ENABLED: '1',
    PLATFORM_UPLOAD_MAX_BYTES: '5242880',
  }), {
    host: '0.0.0.0',
    port: 4500,
    registrationEnabled: true,
    uploadsEnabled: true,
    maxUploadBytes: 5242880,
  });
});

test('invalid platform ports are rejected before the listener starts', () => {
  for (const PLATFORM_PORT of ['0', '65536', '1.5', 'nope']) {
    assert.throws(
      () => getPlatformServerConfig({ PLATFORM_PORT }),
      /PLATFORM_PORT must be an integer/,
      `expected ${PLATFORM_PORT} to be rejected`,
    );
  }
  for (const PLATFORM_UPLOAD_MAX_BYTES of ['0', '-1', '1.2', 'NaN']) {
    assert.throws(() => getPlatformServerConfig({ PLATFORM_UPLOAD_MAX_BYTES }), /PLATFORM_UPLOAD_MAX_BYTES/);
  }
});
