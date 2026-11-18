#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env.platform.local');
const COMPOSE_FILE = path.join(ROOT, 'compose.platform.local.yml');
const BACKUP_ROOT = path.join(ROOT, 'backups', 'platform-v2');
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const MANAGED_OBJECT_KEY = new RegExp(`^(?:quarantine|media)/${UUID}/${UUID}/${UUID}$`, 'i');
const REQUIRED_SERVICES = ['database', 'redis', 'storage'];
const WRITER_SERVICES = ['api', 'worker'];

function readLocalEnvironment(filePath = ENV_FILE) {
  if (!existsSync(filePath)) throw new Error('Local secrets are missing. Run `npm run platform:local:init` and `npm run platform:local:up` first.');
  const env = {};
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  const bucket = env.PLATFORM_S3_BUCKET || 'vision-media';
  const databaseName = env.PLATFORM_DB_NAME || 'vision_platform';
  const databaseUser = env.PLATFORM_DB_USER || 'vision_platform';
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('PLATFORM_S3_BUCKET is not a valid DNS-style bucket name.');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(databaseName)) throw new Error('PLATFORM_DB_NAME must be a simple PostgreSQL identifier.');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(databaseUser)) throw new Error('PLATFORM_DB_USER must be a simple PostgreSQL identifier.');
  return { ...env, PLATFORM_S3_BUCKET: bucket, PLATFORM_DB_NAME: databaseName, PLATFORM_DB_USER: databaseUser };
}

function readFileUtf8(filePath) {
  return readFileSync(filePath, 'utf8');
}

function composePrefix() {
  return ['compose', '--env-file', ENV_FILE, '-f', COMPOSE_FILE];
}

function runCompose(args, { capture = false } = {}) {
  const result = spawnSync('docker', [...composePrefix(), ...args], {
    cwd: ROOT,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Could not run Docker Compose: ${result.error.message}. Install Docker Desktop with the WSL2 backend, then reopen the terminal.`);
  if (result.status !== 0) throw new Error(`Docker Compose command failed with status ${result.status ?? 'unknown'}.`);
  return capture ? String(result.stdout || '') : '';
}

function runningServices() {
  return new Set(runCompose(['ps', '--status', 'running', '--services'], { capture: true })
    .split(/\r?\n/).map((service) => service.trim()).filter(Boolean));
}

function requireInfrastructure(services) {
  const missing = REQUIRED_SERVICES.filter((service) => !services.has(service));
  if (missing.length) throw new Error(`Start the local stack first; required running service(s): ${missing.join(', ')}. Run [1mnpm run platform:local:up[0m.`);
}

function setPrivatePermissions(filePath, directory = false) {
  try { chmodSync(filePath, directory ? 0o700 : 0o600); } catch { /* Windows ACLs are managed by the user account. */ }
}

function uniqueTempPath(label, id) {
  return `/tmp/vision-platform-${id}-${label}`;
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  return { sizeBytes, sha256: hash.digest('hex') };
}

function walkFiles(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Backup bundle contains a symbolic link: ${key}`);
    if (entry.isDirectory()) files.push(...walkFiles(absolute, key));
    else if (entry.isFile()) files.push({ absolute, key });
    else throw new Error(`Backup bundle contains an unsupported filesystem entry: ${key}`);
  }
  return files;
}

function defaultBackupPath(label = 'backup') {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  return path.join(BACKUP_ROOT, `${label}-${timestamp}`);
}

function resolveBackupPath(value, label = 'backup') {
  return path.resolve(ROOT, value || defaultBackupPath(label));
}

async function writeBackupManifest(directory, bucket, databaseName) {
  const databasePath = path.join(directory, 'database.dump');
  const redisPath = path.join(directory, 'redis.rdb');
  const objectsDirectory = path.join(directory, 'objects');
  for (const candidate of [databasePath, redisPath]) {
    if (!statSync(candidate, { throwIfNoEntry: false })?.isFile()) throw new Error(`Backup component is missing: ${path.basename(candidate)}`);
  }
  if (!statSync(objectsDirectory, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Backup object directory is missing.');

  const [database, redis] = await Promise.all([hashFile(databasePath), hashFile(redisPath)]);
  if (!database.sizeBytes || !redis.sizeBytes) throw new Error('Database dump and Redis snapshot must not be empty.');
  const objects = [];
  let totalBytes = 0;
  for (const file of walkFiles(objectsDirectory)) {
    const key = file.key.replaceAll(path.sep, '/');
    if (!MANAGED_OBJECT_KEY.test(key)) throw new Error(`Unexpected key in private media backup: ${key}`);
    const info = await hashFile(file.absolute);
    if (!info.sizeBytes) throw new Error(`Empty media object in backup: ${key}`);
    totalBytes += info.sizeBytes;
    objects.push({ key, sizeBytes: info.sizeBytes, sha256: info.sha256 });
  }
  objects.sort((left, right) => left.key.localeCompare(right.key));
  const manifest = {
    schemaVersion: 1,
    platform: 'vision-platform-local',
    createdAt: new Date().toISOString(),
    bucket,
    database: { file: 'database.dump', format: 'pg_dump-custom', databaseName, ...database },
    redis: { file: 'redis.rdb', format: 'redis-rdb', ...redis },
    objects: { directory: 'objects', count: objects.length, totalBytes, files: objects },
  };
  const manifestPath = path.join(directory, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  setPrivatePermissions(manifestPath);
  return manifest;
}

/** Verify every file, hash and managed S3 key before a restore can mutate local volumes. */
export async function verifyPlatformBackup(backupPath, expectedBucket, expectedDatabase = 'vision_platform') {
  const directory = path.resolve(backupPath);
  const manifestPath = path.join(directory, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileUtf8(manifestPath));
  } catch {
    throw new Error('Backup manifest is missing or is not valid JSON.');
  }
  if (manifest?.schemaVersion !== 1 || manifest?.platform !== 'vision-platform-local') {
    throw new Error('Unsupported platform backup manifest.');
  }
  if (manifest.bucket !== expectedBucket) {
    throw new Error(`Backup bucket ${JSON.stringify(manifest.bucket)} does not match local bucket ${JSON.stringify(expectedBucket)}.`);
  }
  if (!Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('Backup manifest timestamp is invalid.');
  for (const [component, expectedFile, expectedFormat] of [
    ['database', 'database.dump', 'pg_dump-custom'],
    ['redis', 'redis.rdb', 'redis-rdb'],
  ]) {
    const record = manifest[component];
    if (record?.file !== expectedFile || record?.format !== expectedFormat
      || (component === 'database' && record.databaseName !== expectedDatabase)
      || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 1
      || !/^[a-f0-9]{64}$/.test(record.sha256 || '')) {
      throw new Error(`Backup ${component} manifest entry is invalid.`);
    }
    const filePath = path.join(directory, expectedFile);
    if (!statSync(filePath, { throwIfNoEntry: false })?.isFile()) throw new Error(`Backup file is missing: ${expectedFile}`);
    const actual = await hashFile(filePath);
    if (actual.sizeBytes !== record.sizeBytes || actual.sha256 !== record.sha256) {
      throw new Error(`Backup file failed integrity verification: ${expectedFile}`);
    }
  }

  const records = manifest.objects?.files;
  if (manifest.objects?.directory !== 'objects' || !Array.isArray(records)
    || manifest.objects.count !== records.length || !Number.isSafeInteger(manifest.objects.totalBytes)
    || manifest.objects.totalBytes < 0) {
    throw new Error('Backup object manifest entry is invalid.');
  }
  const seen = new Set();
  let totalBytes = 0;
  for (const record of records) {
    if (!record || typeof record.key !== 'string' || !MANAGED_OBJECT_KEY.test(record.key)
      || seen.has(record.key) || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 1
      || !/^[a-f0-9]{64}$/.test(record.sha256 || '')) {
      throw new Error('Backup contains an invalid or duplicate object manifest entry.');
    }
    seen.add(record.key);
    const filePath = path.resolve(directory, 'objects', ...record.key.split('/'));
    const objectsRoot = path.resolve(directory, 'objects') + path.sep;
    if (!filePath.startsWith(objectsRoot)) throw new Error('Backup manifest contains an unsafe object path.');
    if (!statSync(filePath, { throwIfNoEntry: false })?.isFile()) throw new Error(`Backup object is missing: ${record.key}`);
    const actual = await hashFile(filePath);
    if (actual.sizeBytes !== record.sizeBytes || actual.sha256 !== record.sha256) {
      throw new Error(`Backup object failed integrity verification: ${record.key}`);
    }
    totalBytes += actual.sizeBytes;
  }
  if (totalBytes !== manifest.objects.totalBytes) throw new Error('Backup object total size does not match its manifest.');
  const actualFiles = walkFiles(path.join(directory, 'objects')).map(({ key }) => key.replaceAll(path.sep, '/')).sort();
  const manifestFiles = [...seen].sort();
  if (actualFiles.length !== manifestFiles.length || actualFiles.some((key, index) => key !== manifestFiles[index])) {
    throw new Error('Backup object directory contains missing or unlisted files.');
  }
  return manifest;
}

function cleanComposeTemp(service, remotePath) {
  try {
    runCompose(['exec', '-T', service, 'rm', '-rf', remotePath]);
  } catch {
    console.warn(`Could not remove temporary backup file from the ${service} container; inspect it before retrying.`);
  }
}

/** Snapshot the quiesced PostgreSQL database, MinIO bucket and Redis queue state. */
export async function createPlatformBackup({ outputPath, leaveStoppedOnSuccess = false, label = 'backup' } = {}) {
  const env = readLocalEnvironment();
  const bucket = env.PLATFORM_S3_BUCKET;
  const services = runningServices();
  requireInfrastructure(services);
  const writers = WRITER_SERVICES.filter((service) => services.has(service));
  const directory = resolveBackupPath(outputPath, label);
  mkdirSync(path.dirname(directory), { recursive: true });
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  setPrivatePermissions(directory, true);

  const id = randomUUID();
  const dbTemp = uniqueTempPath(`${id}.dump`, id);
  const redisTemp = uniqueTempPath(`${id}.rdb`, id);
  const objectsTemp = uniqueTempPath(`${id}-objects`, id);
  let stoppedWriters = false;
  let completed = false;
  try {
    if (writers.length) {
      stoppedWriters = true;
      runCompose(['stop', ...writers]);
    }
    runCompose(['exec', '-T', 'database', 'sh', '-ec',
      `pg_dump --no-password --format=custom --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --file="${dbTemp}" && pg_restore --list "${dbTemp}" >/dev/null`]);
    runCompose(['cp', `database:${dbTemp}`, path.join(directory, 'database.dump')]);
    setPrivatePermissions(path.join(directory, 'database.dump'));

    runCompose(['exec', '-T', 'storage', 'mkdir', '-p', objectsTemp]);
    runCompose(['exec', '-T', 'storage', 'mc', 'mirror', '--overwrite', `local/${bucket}`, objectsTemp]);
    const localObjects = path.join(directory, 'objects');
    mkdirSync(localObjects, { mode: 0o700 });
    setPrivatePermissions(localObjects, true);
    runCompose(['cp', `storage:${objectsTemp}/.`, localObjects]);

    runCompose(['exec', '-T', 'redis', 'sh', '-ec',
      `REDISCLI_AUTH="$PLATFORM_REDIS_PASSWORD" redis-cli --no-auth-warning --rdb "${redisTemp}"`]);
    runCompose(['cp', `redis:${redisTemp}`, path.join(directory, 'redis.rdb')]);
    setPrivatePermissions(path.join(directory, 'redis.rdb'));

    const manifest = await writeBackupManifest(directory, bucket, env.PLATFORM_DB_NAME);
    completed = true;
    console.log(`Created verified local platform backup at ${directory}`);
    console.log(`Database ${manifest.database.sizeBytes} bytes; Redis ${manifest.redis.sizeBytes} bytes; ${manifest.objects.count} S3 object(s), ${manifest.objects.totalBytes} bytes.`);
    return { directory, manifest, writers };
  } finally {
    cleanComposeTemp('database', dbTemp);
    cleanComposeTemp('redis', redisTemp);
    cleanComposeTemp('storage', objectsTemp);
    if (!completed) {
      try { rmSync(directory, { recursive: true, force: true }); } catch {
        console.error(`Could not remove incomplete backup directory ${directory}; keep it out of Git and inspect it manually.`);
      }
    }
    if (stoppedWriters && (!leaveStoppedOnSuccess || !completed) && writers.length) {
      try { runCompose(['start', ...writers]); } catch (error) {
        console.error('Could not restart the local API/worker after backup; leave the data services untouched and inspect `npm run platform:local:status`.');
        throw error;
      }
    }
  }
}

function copyObjectTreeIntoStorage(sourcePath, destinationPath) {
  runCompose(['exec', '-T', 'storage', 'mkdir', '-p', destinationPath]);
  runCompose(['cp', `${sourcePath}${path.sep}.`, `storage:${destinationPath}`]);
}

function validateRestoreArtifacts(directory, id) {
  const databaseTemp = uniqueTempPath(`${id}-validate.dump`, id);
  const redisTemp = uniqueTempPath(`${id}-validate.rdb`, id);
  try {
    runCompose(['cp', path.join(directory, 'database.dump'), `database:${databaseTemp}`]);
    runCompose(['exec', '-T', 'database', 'sh', '-ec', `pg_restore --list "${databaseTemp}" >/dev/null`]);
    runCompose(['cp', path.join(directory, 'redis.rdb'), `redis:${redisTemp}`]);
    runCompose(['exec', '-T', 'redis', 'redis-check-rdb', redisTemp]);
  } finally {
    cleanComposeTemp('database', databaseTemp);
    cleanComposeTemp('redis', redisTemp);
  }
}

function restoreRedisSnapshot(backupRedisPath, id) {
  const volumeSnapshot = '/data/vision-platform-restore.rdb';
  runCompose(['cp', backupRedisPath, `redis:${volumeSnapshot}`]);
  runCompose(['exec', '-T', 'redis', 'redis-check-rdb', volumeSnapshot]);
  runCompose(['stop', 'redis']);
  // Redis 7 prioritizes its multi-part AOF manifest over dump.rdb. Replace the
  // RDB and remove only this local Redis AOF before bringing the service back.
  runCompose(['run', '--rm', '--no-deps', '--entrypoint', 'sh', 'redis', '-ec',
    `cp "${volumeSnapshot}" /data/dump.rdb && chown redis:redis /data/dump.rdb && chmod 600 /data/dump.rdb && rm -rf /data/appendonlydir /data/appendonly.aof && rm -f "${volumeSnapshot}"`]);
  runCompose(['up', '-d', '--wait', 'redis']);
  cleanComposeTemp('redis', volumeSnapshot);
}

/** Restore only after verifying the full bundle; preserve a pre-restore safety backup. */
export async function restorePlatformBackup(backupPath, { confirmed = false } = {}) {
  if (!confirmed) throw new Error('Restore is destructive. Pass the explicit `--confirm` flag after reviewing the target backup.');
  const env = readLocalEnvironment();
  const directory = path.resolve(backupPath);
  const manifest = await verifyPlatformBackup(directory, env.PLATFORM_S3_BUCKET, env.PLATFORM_DB_NAME);
  const services = runningServices();
  requireInfrastructure(services);
  const writers = WRITER_SERVICES.filter((service) => services.has(service));
  const id = randomUUID();
  validateRestoreArtifacts(directory, id);

  console.log('Creating an automatic pre-restore safety backup before replacing local platform data.');
  const safety = await createPlatformBackup({ leaveStoppedOnSuccess: true, label: 'pre-restore' });
  console.log(`Pre-restore safety backup: ${safety.directory}`);

  const dbTemp = uniqueTempPath(`${id}.dump`, id);
  const objectTemp = uniqueTempPath(`${id}-restore-objects`, id);
  try {
    runCompose(['cp', path.join(directory, 'database.dump'), `database:${dbTemp}`]);
    runCompose(['exec', '-T', 'database', 'sh', '-ec', `pg_restore --list "${dbTemp}" >/dev/null`]);
    copyObjectTreeIntoStorage(path.join(directory, 'objects'), objectTemp);

    restoreRedisSnapshot(path.join(directory, 'redis.rdb'), id);
    runCompose(['exec', '-T', 'storage', 'mc', 'mirror', '--overwrite', '--remove', objectTemp, `local/${manifest.bucket}`]);
    runCompose(['exec', '-T', 'database', 'sh', '-ec',
      `dropdb --no-password --force --username="$POSTGRES_USER" --maintenance-db=postgres "$POSTGRES_DB" && createdb --no-password --username="$POSTGRES_USER" --maintenance-db=postgres "$POSTGRES_DB" && pg_restore --no-password --no-owner --no-acl --exit-on-error --single-transaction --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" "${dbTemp}"`]);

    console.log('Restore completed and integrity checks passed. API and worker remain stopped.');
    console.log('Review the restored local data, then run `npm run platform:local:up` to apply forward migrations and restart services.');
    return { directory, safetyBackup: safety.directory, manifest, writers };
  } finally {
    cleanComposeTemp('database', dbTemp);
    cleanComposeTemp('storage', objectTemp);
  }
}

function parseBackupArgs(args) {
  if (args.length > 1 || args.some((argument) => argument.startsWith('--'))) {
    throw new Error('Usage: npm run platform:local:backup [backup-directory]');
  }
  return args[0] ? path.resolve(ROOT, args[0]) : undefined;
}

function parseRestoreArgs(args) {
  const confirmed = args.includes('--confirm');
  const paths = args.filter((argument) => argument !== '--confirm');
  if (!confirmed || paths.length !== 1 || paths[0].startsWith('--')) {
    throw new Error('Usage: npm run platform:local:restore -- <backup-directory> --confirm');
  }
  return { directory: path.resolve(ROOT, paths[0]), confirmed };
}

export async function runPlatformLocalDataCommand(command, args = []) {
  if (command === 'backup') {
    await createPlatformBackup({ outputPath: parseBackupArgs(args) });
    return;
  }
  if (command === 'restore') {
    const parsed = parseRestoreArgs(args);
    await restorePlatformBackup(parsed.directory, { confirmed: parsed.confirmed });
    return;
  }
  throw new Error(`Unknown local data command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  runPlatformLocalDataCommand(command, args).catch((error) => {
    console.error(error?.message || 'Local platform data operation failed.');
    process.exitCode = 1;
  });
}
