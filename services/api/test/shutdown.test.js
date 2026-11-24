import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 4821;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'shutdown-test-password';
let child;
let dataDir;

async function waitForServer() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      // Сервер ещё запускается.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('API не поднялся для проверки штатной остановки');
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'vision-shutdown-'));
  child = spawn(process.execPath, ['services/api/src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(PORT),
      DATA_DIR: dataDir,
      VISION_PASSWORD: PASSWORD,
      SEED_ENABLED: '0',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[shutdown-api] ${chunk}`));
  await waitForServer();
});

after(() => {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test('штатное выключение доступно владельцу и завершает API-процесс', async () => {
  const denied = await fetch(`${BASE}/api/shutdown`, { method: 'POST' });
  assert.equal(denied.status, 401);
  assert.equal((await fetch(`${BASE}/api/health`)).status, 200);

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  assert.ok(token);

  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const response = await fetch(`${BASE}/api/shutdown`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, stopping: true });

  const result = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('процесс API не завершился')), 5000)),
  ]);
  assert.equal(result.code, 0);
});
