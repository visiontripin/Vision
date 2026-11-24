import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENTRY = path.join(ROOT, 'services', 'api', 'src', 'server.js');

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: server.address().port };
}

function startServer({ host, port, dataDir }) {
  return spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      DATA_DIR: dataDir,
      VISION_PASSWORD: '',
      VISION_PASSWORD_FILE: '',
      VISION_SECRET: '',
      NODE_ENV: 'test',
      SEED_ENABLED: '0',
      TRANSCODE: '0',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function waitForExit(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('refuses an unauthenticated non-loopback listener before opening the database', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'vision-startup-guard-'));
  const child = startServer({ host: '0.0.0.0', port: 0, dataDir });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const { code } = await waitForExit(child);
    assert.equal(code, 1);
    assert.match(stderr, /Refusing to listen on non-loopback host 0\.0\.0\.0 without explicit credentials/);
    assert.match(stderr, /HOST=127\.0\.0\.1/);
    assert.deepEqual(readdirSync(dataDir), [], 'guard runs before SQLite creates files');
  } finally {
    child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('reports EADDRINUSE as a human-readable startup error', async () => {
  const { server: occupied, port } = await reservePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'vision-port-conflict-'));
  const child = startServer({ host: '127.0.0.1', port, dataDir });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const { code } = await waitForExit(child);
    assert.equal(code, 1);
    assert.match(stderr, new RegExp(`Порт ${port} уже занят`));
    assert.match(stderr, /PORT=<номер> npm start/);
    assert.doesNotMatch(stderr, /Error: listen EADDRINUSE/);
  } finally {
    child.kill('SIGKILL');
    await close(occupied);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
