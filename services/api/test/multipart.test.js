import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { boundaryOf, firstPartStream } from '../src/multipart.js';

/**
 * Загрузка с телефона (H4): сервер принимает **оба** вида тела.
 *
 * В вебе файл отправляется телом запроса (`Content-Type: audio/*`), в React
 * Native — только через `FormData`, то есть multipart. Читать 300 МБ в память
 * на телефоне нельзя, поэтому разбор потоковый; здесь проверяем и сам разбор на
 * синтетических потоках, и живую загрузку: телефонный запрос должен давать тот
 * же трек, что и веб-запрос.
 */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const PORT = 4802;
const BASE = `http://127.0.0.1:${PORT}`;

/* --------------------------------- разбор --------------------------------- */

/** Собирает multipart-тело и отдаёт его кусочками, как это делает сокет. */
function multipartBody({ boundary = '----visionboundary', file = Buffer.from('hello'), mime = 'audio/mpeg', name = 'a.mp3' } = {}) {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return Buffer.concat([head, file, tail]);
}

async function* chunks(buffer, size) {
  for (let offset = 0; offset < buffer.length; offset += size) {
    yield buffer.subarray(offset, offset + size);
  }
}

async function readAll(stream) {
  const parts = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}

describe('multipart: разбор', () => {
  test('граница берётся из заголовка, в том числе в кавычках', () => {
    assert.equal(boundaryOf('multipart/form-data; boundary=abc'), 'abc');
    assert.equal(boundaryOf('multipart/form-data; boundary="a b c"'), 'a b c');
    assert.equal(boundaryOf('audio/mpeg'), null);
    assert.equal(boundaryOf('multipart/form-data'), null);
    assert.equal(boundaryOf(undefined), null);
  });

  test('файл извлекается целиком, независимо от размера чанков', async () => {
    const file = Buffer.from('RIFF....WAVEfmt ....data');
    for (const size of [1, 3, 7, 64, 10_000]) {
      const body = multipartBody({ file, mime: 'audio/wav', name: 'Nils Frahm - Says.wav' });
      const part = firstPartStream(chunks(body, size), 'multipart/form-data; boundary=----visionboundary');
      assert.ok(part, 'multipart распознан');
      const extracted = await readAll(part.stream);
      assert.equal(extracted.toString(), file.toString(), `чанк по ${size} байт`);
      assert.equal(part.mime, 'audio/wav');
      assert.equal(part.filename, 'Nils Frahm - Says.wav');
    }
  });

  test('содержимое с CRLF и похожее на границу не обрезается', async () => {
    // такие байты бывают в любом аудиофайле: парсер не должен искать «почти границу»
    const file = Buffer.from('\r\n--not-a-boundary\r\n\r\n\x00\x01binary');
    const body = multipartBody({ file });
    const part = firstPartStream(chunks(body, 5), 'multipart/form-data; boundary=----visionboundary');
    assert.equal((await readAll(part.stream)).toString(), file.toString());
  });

  test('не multipart — не наша забота: null', () => {
    assert.equal(firstPartStream(chunks(Buffer.from('abc'), 2), 'audio/wav'), null);
  });

  test('обрезанное тело отдаётся как есть: обрезанный файл отвергнет сигнатура', async () => {
    const body = multipartBody({ file: Buffer.from('0123456789') });
    const cut = body.subarray(0, body.length - 20);
    const part = firstPartStream(chunks(cut, 8), 'multipart/form-data; boundary=----visionboundary');
    const extracted = await readAll(part.stream);
    assert.equal(extracted.toString().startsWith('0123456789'), true);
  });
});

/* ------------------------------- живая загрузка ---------------------------- */

function wav() {
  const data = 20;
  const buffer = Buffer.alloc(44 + data);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(36 + data, 4);
  buffer.write('WAVE', 8, 'latin1');
  buffer.write('fmt ', 12, 'latin1');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'latin1');
  buffer.writeUInt32LE(data, 40);
  return buffer;
}

let child;
let dataDir;
let token;

async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/me`);
      if (res.status === 401 || res.status === 200) return;
    } catch {
      /* ещё поднимается */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('сервер не поднялся');
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'vision-multipart-'));
  child = spawn(process.execPath, ['services/api/src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      VISION_PASSWORD: 'vision',
      NODE_ENV: 'test',
      TRANSCODE: '0',
      SEED_ENABLED: '0',
      BACKUP_EVERY_HOURS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  await waitForServer();

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'vision' }),
  });
  token = (await login.json()).token;
});

after(() => {
  child?.kill('SIGTERM');
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('API: загрузка с телефона', () => {
  test('multipart от телефона создаёт трек так же, как тело-файл', async () => {
    const form = new FormData();
    form.append('file', new Blob([wav()], { type: 'audio/wav' }), 'Nils Frahm - Says.wav');
    const res = await fetch(`${BASE}/api/tracks?title=Says&artist=Nils+Frahm&genre=Ambient`, {
      method: 'POST',
      headers: auth(),
      body: form,
    });
    assert.equal(res.status, 201);
    const track = await res.json();

    // размер — размер файла, а не multipart-обёртки: обёртку не должно быть видно
    assert.equal(track.size, wav().length);
    assert.equal(track.mime, 'audio/wav');
    assert.equal(track.title, 'Says');
    assert.equal(track.artist, 'Nils Frahm');
    assert.equal(track.genre, 'Ambient');
    assert.match(track.checksum, /^[a-f0-9]{64}$/);
  });

  test('тело-файл (веб) продолжает работать: контракт не сломан', async () => {
    const other = Buffer.from(wav());
    other[44] = 7; // другой файл — иначе дедупликация честно вернёт 409
    const res = await fetch(`${BASE}/api/tracks?title=Slow+Tide`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'audio/wav' },
      body: other,
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).size, other.length);
  });

  test('повтор того же файла с телефона — 409 duplicate, а не второй трек', async () => {
    const form = new FormData();
    form.append('file', new Blob([wav()], { type: 'audio/wav' }), 'again.wav');
    const res = await fetch(`${BASE}/api/tracks?title=Again`, { method: 'POST', headers: auth(), body: form });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, 'duplicate');
    assert.ok(body.existing.id);
  });

  test('multipart с не-аудио — 415, а не «загружено»', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('просто текст')], { type: 'text/plain' }), 'notes.txt');
    const res = await fetch(`${BASE}/api/tracks?title=Заметки`, { method: 'POST', headers: auth(), body: form });
    assert.equal(res.status, 415);
    assert.equal((await res.json()).error.code, 'unsupported_type');
  });

  test('загрузка без токена — 401 и для multipart', async () => {
    const form = new FormData();
    form.append('file', new Blob([wav()], { type: 'audio/wav' }), 'x.wav');
    const res = await fetch(`${BASE}/api/tracks?title=x`, { method: 'POST', body: form });
    assert.equal(res.status, 401);
  });
});
