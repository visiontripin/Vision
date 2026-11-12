#!/usr/bin/env node
/**
 * Точка входа встроенного сервера: выполняется внутри Node-рантайма на телефоне.
 *
 *   node bootstrap.mjs --data <каталог> --port 4000 [--public] [--auth <токен>]
 *
 * Задача — не дать приложению «молча ничего не делать», если сервер не поднялся:
 *
 *  1. пишем `state.json` (running/failed + причина) — приложение читает его и
 *     показывает текст, а не пустой экран;
 *  2. ловим падения процесса (`uncaughtException`, `unhandledRejection`) — при
 *     падении внутри `node:http` Node иначе просто умирает без объяснений;
 *  3. поднимаем HTTP-сервер сами: отдельный маленький сервер с `/health` и
 *     раздачей файлов, чтобы диагностика работала даже без полного API.
 *
 * Полный API (`services/api`) подключается, если он упакован рядом: bootstrap
 * проверяет наличие `server.mjs` и запускает его в том же процессе. Если его
 * нет — работает диагностический сервер: приложение всё равно видит «сервер
 * отвечает», а в `state.json` честно записано `mode: "diagnostic"`.
 *
 * Зависимостей нет — только `node:` модули: это важно, потому что в APK нельзя
 * доустановить npm-пакеты.
 */
import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- аргументы -------------------------------------------------------------
function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const DATA_DIR = path.resolve(arg('data', path.join(HERE, 'data')));
const PORT = Number(arg('port', '4000')) || 4000;
const HOST = arg('host', '127.0.0.1');
const PUBLIC = process.argv.includes('--public');
const AUTH = arg('auth', null);
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const VERSION = arg('version', '0.9.0');

mkdirSync(DATA_DIR, { recursive: true });

function writeState(patch) {
  const state = {
    ok: patch.phase === 'running',
    phase: patch.phase ?? 'starting',
    port: PORT,
    host: PUBLIC ? '0.0.0.0' : HOST,
    url: `http://${PUBLIC ? '127.0.0.1' : HOST}:${PORT}`,
    pid: process.pid,
    version: VERSION,
    runtime: process.version,
    mode: patch.mode ?? 'diagnostic',
    error: patch.error ?? null,
    at: Date.now(),
  };
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('[bootstrap] не удалось записать state.json:', error?.message ?? error);
  }
  return state;
}

writeState({ phase: 'starting' });

process.on('uncaughtException', (error) => {
  console.error('[bootstrap] необработанное исключение:', error?.stack ?? error);
  writeState({ phase: 'failed', error: String(error?.message ?? error) });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[bootstrap] необработанный reject:', reason?.stack ?? reason);
  writeState({ phase: 'failed', error: String(reason?.message ?? reason) });
  process.exit(1);
});

// --- MIME для раздачи файлов ----------------------------------------------
const MIME = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function cors(res) {
  // Приложению на телефоне и `WebView`-тестеру origin не важен, но без этих
  // заголовков браузерный тестер не прочитает ответ.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS');
}

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function authorized(req, url) {
  if (!AUTH) return true;
  const header = String(req.headers.authorization ?? '');
  if (header === `Bearer ${AUTH}`) return true;
  const token = url.searchParams.get('token');
  return token === AUTH;
}

/** Файлы, которые можно скачать: только внутри DATA_DIR, без `..`. */
function resolveSafe(root, relative) {
  const target = path.resolve(root, `.${path.posix.normalize(`/${relative}`)}`);
  return target.startsWith(root + path.sep) || target === root ? target : null;
}

function serveFile(req, res, file, url) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return json(res, 404, { ok: false, error: 'not_found' });
  }
  const total = stat.size;
  const type = mimeFor(file);
  const range = String(req.headers.range ?? '');
  const match = /bytes=(\d*)-(\d*)/.exec(range);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', type);

  if (!match) {
    res.writeHead(200, { 'Content-Length': total });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(file).pipe(res);
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : total - 1;
  if (!match[1] && match[2]) {
    // `bytes=-N` — последние N байт (перемотка в конец)
    start = Math.max(0, total - Number(match[2]));
    end = total - 1;
  }
  end = Math.min(end, total - 1);

  if (!Number.isFinite(start) || start > end || start >= total) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    return res.end();
  }

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Content-Length': end - start + 1,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file, { start, end }).pipe(res);
}

// --- список файлов в библиотеке -------------------------------------------
function listFiles(dir = DATA_DIR, base = '') {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.name === 'state.json' && !base) continue;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else {
      try {
        const info = statSync(path.join(dir, entry.name));
        out.push({ name: rel, size: info.size, mime: mimeFor(entry.name) });
      } catch {
        /* файл исчез между readdir и stat — не повод падать */
      }
    }
  }
  return out;
}

// --- сервер ---------------------------------------------------------------
const started = Date.now();

const server = createServer(async (req, res) => {
  cors(res);
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/api/health' || url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      embedded: true,
      mode: server.__mode,
      version: VERSION,
      runtime: process.version,
      platform: `${process.platform}/${process.arch}`,
      uptimeSec: Math.round((Date.now() - started) / 1000),
      dataDir: DATA_DIR,
      auth: Boolean(AUTH),
      public: PUBLIC,
      files: listFiles().length,
    });
  }

  if (!authorized(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' });

  // Остановка по запросу (кнопка «Остановить» на экране сервера). Отвечаем до
  // закрытия сокета, иначе приложение решит, что сервер не отвечает.
  if (url.pathname === '/api/shutdown' && req.method === 'POST') {
    json(res, 200, { ok: true, stop: true });
    setImmediate(() => shutdown('api'));
    return;
  }

  if (url.pathname === '/api/files' && req.method === 'GET') {
    return json(res, 200, { ok: true, files: listFiles() });
  }

  // Приём файла: `PUT /api/files/<имя>` телом — октет-поток.
  // Пишем потоком во временный файл и переименовываем: оборванная загрузка не
  // оставит в библиотеке наполовину записанный трек.
  if (url.pathname.startsWith('/api/files/') && req.method === 'PUT') {
    const rel = decodeURIComponent(url.pathname.slice('/api/files/'.length));
    const file = resolveSafe(DATA_DIR, rel);
    if (!file) return json(res, 400, { ok: false, error: 'bad_path' });
    if (!file.startsWith(path.join(DATA_DIR, 'library'))) return json(res, 403, { ok: false, error: 'outside_library' });

    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.part`;
    const MAX = 500 * 1024 * 1024;
    let size = 0;
    const out = createWriteStream(temp);
    try {
      await new Promise((resolve, reject) => {
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX) {
            req.destroy();
            reject(new Error('file_too_large'));
          }
        });
        req.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        req.pipe(out);
      });
      renameSync(temp, file);
      return json(res, 201, { ok: true, name: rel, size, mime: mimeFor(file) });
    } catch (error) {
      try {
        out.destroy();
        unlinkSync(temp);
      } catch {
        /* временного файла уже нет */
      }
      const code = error?.message === 'file_too_large' ? 413 : 400;
      return json(res, code, { ok: false, error: error?.message ?? 'write_failed' });
    }
  }

  if (url.pathname.startsWith('/api/files/') && req.method === 'DELETE') {
    const rel = decodeURIComponent(url.pathname.slice('/api/files/'.length));
    const file = resolveSafe(DATA_DIR, rel);
    if (!file) return json(res, 400, { ok: false, error: 'bad_path' });
    try {
      unlinkSync(file);
      return json(res, 200, { ok: true, name: rel });
    } catch {
      return json(res, 404, { ok: false, error: 'not_found' });
    }
  }

  if (url.pathname.startsWith('/files/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const rel = decodeURIComponent(url.pathname.slice('/files/'.length));
    const file = resolveSafe(DATA_DIR, rel);
    if (!file) return json(res, 400, { ok: false, error: 'bad_path' });
    return serveFile(req, res, file, url);
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const files = listFiles();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><title>Vision Audio — сервер на телефоне</title>
<body style="font:15px system-ui;background:#07070A;color:#e9e9f1;padding:24px">
<h1 style="font-size:20px">Сервер работает на этом телефоне</h1>
<p style="color:#8f8fa6">Node ${process.version} · порт ${PORT} · режим ${server.__mode}</p>
<p><a style="color:#7c5cff" href="/api/health">/api/health</a> · <a style="color:#7c5cff" href="/api/files">/api/files</a></p>
<p style="color:#8f8fa6">Файлов в библиотеке: ${files.length}</p>
<ul>${files.slice(0, 100).map((f) => `<li><a style="color:#e9e9f1" href="/files/${encodeURI(f.name)}">${f.name}</a> <span style="color:#8f8fa6">${(f.size / 1048576).toFixed(1)} МБ</span></li>`).join('')}</ul>
</body>`);
  }

  return json(res, 404, { ok: false, error: 'not_found', path: url.pathname });
});

// Полный API, если он упакован рядом с bootstrap (`server.mjs`).
const fullApi = path.join(HERE, 'server.mjs');
if (existsSync(fullApi)) {
  try {
    process.env.VISION_DATA_DIR = DATA_DIR;
    process.env.VISION_HOST = PUBLIC ? '0.0.0.0' : HOST;
    process.env.VISION_PORT = String(PORT);
    await import(pathToFileURL(fullApi).href);
    server.__mode = 'full';
    console.log('[bootstrap] полный API подключён:', fullApi);
    writeState({ phase: 'running', mode: 'full' });
  } catch (error) {
    // Полный API не поднялся — диагностический сервер всё равно нужен, иначе
    // пользователь увидит «сервер не запустился» без возможности что-то понять.
    server.__mode = 'diagnostic';
    console.error('[bootstrap] полный API не загрузился, работаем диагностически:', error?.stack ?? error);
    writeState({ phase: 'running', mode: 'diagnostic', error: String(error?.message ?? error) });
  }
} else {
  server.__mode = 'diagnostic';
}

server.on('error', (error) => {
  console.error('[bootstrap] сервер не поднялся:', error?.message ?? error);
  writeState({ phase: 'failed', error: `${error?.code ?? 'error'}: ${error?.message ?? error}` });
  process.exit(1);
});

server.listen(PORT, PUBLIC ? '0.0.0.0' : HOST, () => {
  console.log(`[bootstrap] слушает http://${PUBLIC ? '0.0.0.0' : HOST}:${PORT} · mode=${server.__mode} · node ${process.version}`);
  writeState({ phase: 'running' });
});

// Остановка аккуратная: сначала `phase: stopped` (по нему приложение сразу
// понимает, что сервер снят), потом закрытие сокета, потом выход. Таймер-страховка
// на случай, если открытые соединения не дают `close()` завершиться.
let stopping = false;
function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  console.log('[bootstrap] остановка:', reason);
  writeState({ phase: 'stopped' });
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 1200).unref();
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => shutdown(signal));
}
