import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { createLocalEnvironmentFile, makeLocalEnvironment } from './platform-local.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compose = yaml.parse(readFileSync(path.join(ROOT, 'compose.platform.local.yml'), 'utf8'));

test('local environment uses high-entropy URL-safe secrets and refuses to overwrite them', () => {
  const envText = makeLocalEnvironment((size) => Buffer.alloc(size, 0x5a));
  const password = envText.match(/^PLATFORM_DB_PASSWORD=(.+)$/m)?.[1];
  const authSecret = envText.match(/^PLATFORM_AUTH_SECRET=(.+)$/m)?.[1];
  const redisPassword = envText.match(/^PLATFORM_REDIS_PASSWORD=(.+)$/m)?.[1];
  const s3AccessKeyId = envText.match(/^PLATFORM_S3_ACCESS_KEY_ID=(.+)$/m)?.[1];
  const s3SecretAccessKey = envText.match(/^PLATFORM_S3_SECRET_ACCESS_KEY=(.+)$/m)?.[1];
  assert.match(password, /^[A-Za-z0-9_-]{43}$/);
  assert.match(authSecret, /^[A-Za-z0-9_-]{64}$/);
  assert.match(redisPassword, /^[A-Za-z0-9_-]{43}$/);
  assert.match(s3AccessKeyId, /^[A-Za-z0-9_-]{24}$/);
  assert.match(s3SecretAccessKey, /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(envText, /vision$/m);

  const temp = mkdtempSync(path.join(os.tmpdir(), 'vision-platform-env-'));
  const target = path.join(temp, '.env.platform.local');
  try {
    assert.equal(createLocalEnvironmentFile(target, (size) => Buffer.alloc(size, 0x31)), true);
    const first = readFileSync(target, 'utf8');
    assert.equal(createLocalEnvironmentFile(target, () => { throw new Error('must not replace existing secrets'); }), false);
    assert.equal(readFileSync(target, 'utf8'), first);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('local Compose stack is loopback-bound, registration-closed and persistent', () => {
  assert.equal(compose.services.database.image, 'pgvector/pgvector:pg16');
  assert.equal(compose.services.storage.image, 'ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z');
  assert.deepEqual(compose.services.storage.healthcheck.test, ['CMD', 'mc', 'ready', 'local']);
  assert.match(compose.services.storage.environment.MC_HOST_local, /^http:\/\/\$\{PLATFORM_S3_ACCESS_KEY_ID\}:\$\{PLATFORM_S3_SECRET_ACCESS_KEY\}@127\.0\.0\.1:9000$/);
  assert.equal(compose.services.database.ports, undefined, 'PostgreSQL must not be published to the host');
  assert.equal(compose.services.redis.ports, undefined, 'Redis must not be published to the host');
  assert.deepEqual(compose.services.api.ports, ['127.0.0.1:4400:4400']);
  assert.deepEqual(compose.services.storage.ports, ['127.0.0.1:9001:9000']);
  assert.equal(compose.services.api.environment.PLATFORM_HOST, '0.0.0.0', 'container must accept its private bridge traffic');
  assert.equal(compose.services.api.environment.PLATFORM_REGISTRATION_ENABLED, '0');
  assert.equal(compose.services.api.environment.PLATFORM_UPLOADS_ENABLED, '0');
  assert.equal(compose.services.api.environment.PLATFORM_S3_PUBLIC_ENDPOINT, 'http://127.0.0.1:9001');
  assert.ok(compose.services.api.depends_on.database.condition === 'service_healthy');
  assert.ok(compose.services.api.depends_on.redis.condition === 'service_healthy');
  assert.ok(compose.services.api.depends_on.storage.condition === 'service_healthy');
  assert.ok(compose.services.database.volumes.includes('platform-pgdata:/var/lib/postgresql/data'));
  assert.ok(compose.services.redis.volumes.includes('platform-redisdata:/data'));
  assert.ok(compose.services.storage.volumes.includes('platform-miniodata:/data'));
  assert.ok(compose.volumes['platform-pgdata']);
  assert.ok(compose.volumes['platform-redisdata']);
  assert.ok(compose.volumes['platform-miniodata']);
  assert.equal(compose.services.api.read_only, true);
  assert.equal(compose.services.worker.read_only, true);
  assert.ok(compose.services.worker.tmpfs.some((entry) => entry.startsWith('/tmp:')));
  assert.ok(compose.services.api.cap_drop.includes('ALL'));
  assert.ok(compose.services.worker.cap_drop.includes('ALL'));
});

test('local API image installs only root runtime dependencies and runs unprivileged', () => {
  const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile.platform'), 'utf8');
  assert.match(dockerfile, /node:22\.22\.3-slim/);
  assert.match(dockerfile, /npm ci --omit=dev --omit=optional --ignore-scripts --workspaces=false/);
  assert.match(dockerfile, /apt-get install -y --no-install-recommends ffmpeg ca-certificates/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /services\/api\/src\/platform\/start\.js/);
  assert.doesNotMatch(dockerfile, /COPY \.env/);
});

test('local secret file is excluded from Git and the Docker build context', () => {
  const gitignore = readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  const dockerignore = readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  assert.match(gitignore, /^\.env\.platform\.local$/m);
  assert.match(dockerignore, /^\.env\.\*$/m);
});
