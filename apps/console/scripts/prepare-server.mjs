import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const repoRoot = path.resolve(appRoot, '../..');
const resources = path.join(appRoot, 'src-tauri', 'resources');
const apiSource = path.join(repoRoot, 'services', 'api', 'src');
const consoleDist = path.join(appRoot, 'dist');
const requireFromRepo = createRequire(path.join(repoRoot, 'package.json'));
const expectedNodeVersion = 'v24.22.3';
const nodeWindowsRoot = path.dirname(requireFromRepo.resolve('node-windows/package.json'));
const winSwBinary = path.join(nodeWindowsRoot, 'bin', 'winsw', 'winsw.exe');
const winSwConfig = path.join(nodeWindowsRoot, 'bin', 'winsw', 'winsw.exe.config');
const nodeWindowsLicense = path.join(nodeWindowsRoot, 'LICENSE');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Подготовка ресурсов Vision Server выполняется на Windows x64. Запустите npm run build:windows в Windows workflow.');
}

const nodeCandidates = [
  path.join(appRoot, 'node_modules', 'node-win-x64', 'bin', 'node.exe'),
  path.join(repoRoot, 'node_modules', 'node-win-x64', 'bin', 'node.exe'),
];
let nodeBinary = null;
for (const candidate of nodeCandidates) {
  try {
    const info = await stat(candidate);
    if (info.isFile() && info.size > 10 * 1024 * 1024) {
      nodeBinary = candidate;
      break;
    }
  } catch {
    // Продолжаем поиск: npm может положить optional dependency в корень workspace.
  }
}
if (!nodeBinary) {
  throw new Error('Не найден node-win-x64. Выполните npm ci из корня репозитория на Windows x64.');
}

const nodeVersion = execFileSync(nodeBinary, ['--version'], { encoding: 'utf8' }).trim();
if (nodeVersion !== expectedNodeVersion) {
  throw new Error(`Для Vision Server требуется Node ${expectedNodeVersion}, найден ${nodeVersion}.`);
}

let ffmpegBinary;
try {
  ffmpegBinary = requireFromRepo('ffmpeg-static');
} catch (error) {
  throw new Error(`Не найден ffmpeg-static из корневых зависимостей. Выполните npm ci на Windows x64. ${error.message}`);
}
if (typeof ffmpegBinary !== 'string' || !ffmpegBinary.toLowerCase().endsWith('ffmpeg.exe')) {
  throw new Error(`ffmpeg-static вернул неожиданный путь: ${String(ffmpegBinary)}`);
}
const ffmpegInfo = await stat(ffmpegBinary).catch(() => null);
if (!ffmpegInfo?.isFile() || ffmpegInfo.size < 10 * 1024 * 1024) {
  throw new Error(`Не найден загруженный Windows ffmpeg.exe: ${ffmpegBinary}`);
}

for (const [label, required] of [
  ['WinSW service wrapper', winSwBinary],
  ['WinSW .NET runtime config', winSwConfig],
  ['node-windows licence', nodeWindowsLicense],
]) {
  const info = await stat(required).catch(() => null);
  if (!info?.isFile() || info.size === 0) {
    throw new Error(`Не найден ${label}: ${required}. Проверьте установку node-windows.`);
  }
}

for (const [label, required] of [['API source', apiSource], ['Admin panel build', consoleDist]]) {
  try {
    await stat(required);
  } catch {
    throw new Error(`Не найден ${label}: ${required}. Сначала соберите панель: npm run build.`);
  }
}

await rm(resources, { recursive: true, force: true });
const serverRoot = path.join(resources, 'server');
const ffmpegDir = path.join(serverRoot, 'bin');
const serviceDir = path.join(serverRoot, 'service');
await mkdir(path.join(resources, 'node'), { recursive: true });
await mkdir(path.join(serverRoot, 'services', 'api'), { recursive: true });
await mkdir(path.join(serverRoot, 'apps', 'console'), { recursive: true });
await mkdir(ffmpegDir, { recursive: true });
await mkdir(serviceDir, { recursive: true });

await cp(nodeBinary, path.join(resources, 'node', 'node.exe'));
await cp(apiSource, path.join(serverRoot, 'services', 'api', 'src'), { recursive: true });
await cp(consoleDist, path.join(serverRoot, 'apps', 'console', 'dist'), { recursive: true });
await cp(ffmpegBinary, path.join(ffmpegDir, 'ffmpeg.exe'));
await cp(winSwBinary, path.join(serviceDir, 'VisionServer.exe'));
await cp(winSwConfig, path.join(serviceDir, 'VisionServer.exe.config'));
await cp(nodeWindowsLicense, path.join(serviceDir, 'node-windows-LICENSE.txt'));
await writeFile(
  path.join(serviceDir, 'VisionServer.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<service>\n  <id>VisionServer</id>\n  <name>Vision Server</name>\n  <description>Vision Server home API service</description>\n  <executable>%BASE%\\..\\..\\node\\node.exe</executable>\n  <argument>%BASE%\\..\\services\\api\\src\\start.js</argument>\n  <workingdirectory>%BASE%\\..</workingdirectory>\n  <env name="HOST" value="0.0.0.0" />\n  <env name="PORT" value="4000" />\n  <env name="NODE_ENV" value="production" />\n  <env name="DATA_DIR" value="%ProgramData%\\VisionServer\\data" />\n  <env name="BACKUP_DIR" value="%ProgramData%\\VisionServer\\data\\backups" />\n  <env name="VISION_PASSWORD_FILE" value="%ProgramData%\\VisionServer\\data\\owner-auth.json" />\n  <env name="VISION_SERVER_SETTINGS_FILE" value="%ProgramData%\\VisionServer\\server-manager.json" />\n  <env name="FFMPEG_PATH" value="%BASE%\\..\\bin\\ffmpeg.exe" />\n  <logpath>%ProgramData%\\VisionServer\\logs</logpath>\n  <logmode>roll</logmode>\n  <stoptimeout>30sec</stoptimeout>\n</service>\n`,
);
await writeFile(
  path.join(serverRoot, 'package.json'),
  `${JSON.stringify({ name: 'vision-server-runtime', private: true, type: 'module' }, null, 2)}\n`,
);

console.log(`Node runtime ${nodeVersion}: ${path.join(resources, 'node', 'node.exe')}`);
console.log(`API source copied: ${path.join(serverRoot, 'services', 'api', 'src')}`);
console.log(`Admin panel copied: ${path.join(serverRoot, 'apps', 'console', 'dist')}`);
console.log(`FFmpeg binary copied: ${path.join(ffmpegDir, 'ffmpeg.exe')}`);
