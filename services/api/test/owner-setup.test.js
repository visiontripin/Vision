import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENTRY = path.join(ROOT, 'services', 'api', 'src', 'start.js');
const PASSWORD = 'A long test password 2026';

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function startApi({ port, dataDir, passwordFile }) {
  return spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      VISION_PASSWORD_FILE: passwordFile,
      VISION_SERVER_SETTINGS_FILE: path.join(dataDir, 'server-manager.json'),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

async function waitForApi(port, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vision API exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // The service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Vision API did not become healthy within 15 seconds');
}

async function stopApi(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  let timer;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Vision API did not stop')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('managed Vision Server initializes a hashed owner password once on loopback', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'vision-owner-setup-'));
  const passwordFile = path.join(dataDir, 'owner-auth.json');
  const port = await unusedPort();
  let child = startApi({ port, dataDir, passwordFile });
  const base = `http://127.0.0.1:${port}`;

  try {
    await waitForApi(port, child);

    const setupStatus = await fetch(`${base}/api/setup`);
    assert.equal(setupStatus.status, 200);
    assert.deepEqual(await setupStatus.json(), { configured: false });

    const gated = await fetch(`${base}/api/stats`);
    assert.equal(gated.status, 503);
    assert.equal((await gated.json()).error.code, 'setup_required');

    const crossSite = await fetch(`${base}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(crossSite.status, 403);

    const invalid = await fetch(`${base}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://tauri.localhost' },
      body: JSON.stringify({ password: 'short' }),
    });
    assert.equal(invalid.status, 400);

    const initialized = await fetch(`${base}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://tauri.localhost' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(initialized.status, 201);
    assert.deepEqual(await initialized.json(), { configured: true });

    const duplicate = await fetch(`${base}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'Another valid password' }),
    });
    assert.equal(duplicate.status, 409);

    const wrongLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong password' }),
    });
    assert.equal(wrongLogin.status, 401);

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    const stored = readFileSync(passwordFile, 'utf8');
    assert.equal(stored.includes(PASSWORD), false, 'owner password must not be stored in plaintext');
    assert.equal(JSON.parse(stored).algorithm, 'scrypt');

    await stopApi(child);
    child = startApi({ port, dataDir, passwordFile });
    await waitForApi(port, child);

    const persistedLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(persistedLogin.status, 200);
    const persisted = await fetch(`${base}/api/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(persisted.status, 200, 'owner session secret should survive a service restart');
  } finally {
    await stopApi(child).catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
});
