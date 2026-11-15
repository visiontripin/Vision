#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env.platform.local');
const COMPOSE_FILE = path.join(ROOT, 'compose.platform.local.yml');

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

/** Generate only URL-safe secrets so the local Compose URL needs no escaping. */
export function makeLocalEnvironment(random = randomBytes) {
  const dbPassword = base64url(random(32));
  const authSecret = base64url(random(48));
  const redisPassword = base64url(random(32));
  const s3AccessKeyId = base64url(random(18));
  const s3SecretAccessKey = base64url(random(32));
  return [
    '# Local Vision v2 development secrets. Keep this file private and uncommitted.',
    'PLATFORM_DB_NAME=vision_platform',
    'PLATFORM_DB_USER=vision_platform',
    `PLATFORM_DB_PASSWORD=${dbPassword}`,
    `PLATFORM_AUTH_SECRET=${authSecret}`,
    `PLATFORM_REDIS_PASSWORD=${redisPassword}`,
    `PLATFORM_S3_ACCESS_KEY_ID=${s3AccessKeyId}`,
    `PLATFORM_S3_SECRET_ACCESS_KEY=${s3SecretAccessKey}`,
    'PLATFORM_S3_BUCKET=vision-media',
    'PLATFORM_S3_ENDPOINT=http://storage:9000',
    'PLATFORM_S3_PUBLIC_ENDPOINT=http://127.0.0.1:9001',
    '',
  ].join('\n');
}

export function createLocalEnvironmentFile(filePath = ENV_FILE, random = randomBytes) {
  if (existsSync(filePath)) return false;
  const contents = makeLocalEnvironment(random);
  try {
    writeFileSync(filePath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

function composePrefix() {
  if (!existsSync(ENV_FILE)) {
    console.error('Local secrets are missing. Run `npm run platform:local:init` first.');
    return null;
  }
  return ['compose', '--env-file', ENV_FILE, '-f', COMPOSE_FILE];
}

function runCompose(prefix, args) {
  const result = spawnSync('docker', [...prefix, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    console.error(`Could not run Docker Compose: ${result.error.message}`);
    console.error('Install Docker Desktop with the WSL2 backend, then reopen this terminal.');
    return false;
  }
  if (result.status !== 0) {
    console.error(`Docker Compose exited with status ${result.status ?? 'unknown'}.`);
    return false;
  }
  return true;
}

function help() {
  console.log(`Local-only Vision v2 development stack (not a public beta):

  npm run platform:local:init    Create ignored local secrets once
  npm run platform:local:up      Start Postgres, Redis, MinIO, migrate, API and worker
  npm run platform:local:migrate Apply/check database migrations
  npm run platform:local:status  Show Compose service status
  npm run platform:local:logs    Follow API, worker and infrastructure logs
  npm run platform:local:down    Stop containers; keep local data volumes

The API is published only on 127.0.0.1:4400; MinIO S3 is loopback-only on 127.0.0.1:9001.
Registration and uploads remain disabled. No LAN, firewall or router changes are made.`);
}

function main(command) {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    help();
    return;
  }
  if (command === 'init') {
    if (!createLocalEnvironmentFile()) {
      console.error('Refusing to overwrite .env.platform.local. Keep the existing secrets or remove the file yourself if you intend to replace them.');
      process.exitCode = 1;
      return;
    }
    console.log('Created .env.platform.local with random secrets. The file is ignored by Git; do not share it.');
    return;
  }

  const prefix = composePrefix();
  if (!prefix) {
    process.exitCode = 1;
    return;
  }

  if (command === 'up') {
    const steps = [
      ['up', '-d', 'database', 'redis', 'storage'],
      ['build', 'api'],
      ['run', '--rm', '--no-deps', 'api', 'node', 'services/api/src/platform/migrate.js'],
      ['up', '-d', 'api', 'worker'],
      ['ps'],
    ];
    for (const args of steps) {
      if (!runCompose(prefix, args)) {
        process.exitCode = 1;
        return;
      }
    }
    console.log('Local API URL: http://127.0.0.1:4400/api/v2/health');
    console.log('Local S3 endpoint (private MinIO): http://127.0.0.1:9001; registration/uploads remain disabled.');
    return;
  }

  if (command === 'migrate') {
    const steps = [
      ['up', '-d', 'database'],
      ['build', 'api'],
      ['run', '--rm', '--no-deps', 'api', 'node', 'services/api/src/platform/migrate.js'],
    ];
    for (const args of steps) {
      if (!runCompose(prefix, args)) {
        process.exitCode = 1;
        return;
      }
    }
    return;
  }

  const commands = {
    status: ['ps'],
    logs: ['logs', '--tail=100', '--follow', 'api', 'worker', 'database', 'redis', 'storage'],
    down: ['down'],
  };
  if (!commands[command]) {
    console.error(`Unknown command: ${command}`);
    help();
    process.exitCode = 2;
    return;
  }
  if (command === 'down') {
    console.log('Stopping containers. The named PostgreSQL volume is retained.');
  }
  if (!runCompose(prefix, commands[command])) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv[2]);
}
