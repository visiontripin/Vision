import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  baseName,
  extractAudioFromZip,
  isAudioName,
  isJunkPath,
  readZipDirectory,
  readZipEntry,
} from './zip.ts';

/** Собирает минимальный ZIP: local headers + central directory + EOCD. */
function makeZip(entries: { name: string; data: Buffer; deflate?: boolean }[]): ArrayBuffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const payload = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // UTF-8 имена
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);

  const all = Buffer.concat([...locals, cd, eocd]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

test('каталог ZIP: store и deflate, вложенные папки', () => {
  const zip = makeZip([
    { name: 'music/track-one.mp3', data: Buffer.from('one') },
    { name: 'music/nested/track-two.wav', data: Buffer.from('two-two-two'), deflate: true },
    { name: 'cover.jpg', data: Buffer.from('jpg') },
  ]);

  const entries = readZipDirectory(zip);
  assert.equal(entries.length, 3);

  const names = entries.map((entry) => entry.name);
  assert.deepEqual(names, ['music/track-one.mp3', 'music/nested/track-two.wav', 'cover.jpg']);
  assert.equal(entries[0].method, 0);
  assert.equal(entries[1].method, 8);
});

test('распаковка deflate возвращает исходные байты', async () => {
  const payload = Buffer.from('Vision Audio — проверка распаковки, '.repeat(20));
  const zip = makeZip([{ name: 'a.mp3', data: payload, deflate: true }]);

  const [entry] = readZipDirectory(zip);
  const blob = await readZipEntry(zip, entry);
  assert.equal(Buffer.from(await blob.arrayBuffer()).toString(), payload.toString());
});

test('мусор отбрасывается, аудио остаётся', () => {
  assert.equal(isAudioName('song.MP3'), true);
  assert.equal(isAudioName('song.opus'), true);
  assert.equal(isAudioName('song.txt'), false);
  assert.equal(isJunkPath('__MACOSX/._song.mp3'), true);
  assert.equal(isJunkPath('music/.DS_Store'), true);
  assert.equal(isJunkPath('music/song.mp3'), false);
  assert.equal(baseName('deep/folder/song.mp3'), 'song.mp3');
});

test('повреждённый архив даёт понятную ошибку', () => {
  const garbage = new Uint8Array(64).buffer;
  assert.throws(() => readZipDirectory(garbage), /ZIP|повреждён/i);
});

test('extractAudioFromZip: только аудио, с исходными именами', async () => {
  const zip = makeZip([
    { name: 'album/01 Intro.mp3', data: Buffer.from('a') },
    { name: 'album/02 Theme.flac', data: Buffer.from('b'), deflate: true },
    { name: 'album/readme.txt', data: Buffer.from('c') },
    { name: '__MACOSX/._01 Intro.mp3', data: Buffer.from('d') },
  ]);

  const file = new File([zip], 'album.zip', { type: 'application/zip' });
  const result = await extractAudioFromZip(file);

  assert.equal(result.files.length, 2);
  assert.deepEqual(
    result.files.map((item) => item.name).sort(),
    ['01 Intro.mp3', '02 Theme.flac']
  );
  assert.equal(result.truncated, false);
  assert.ok(result.skipped >= 2);

  // папка «album» не похожа на исполнителя — подсказок нет
  assert.deepEqual(result.artistHints, {});
});

test('исполнитель подсказывается из папки «Artist - Album»', async () => {
  const zip = makeZip([
    { name: 'Kira Voss - Chrome Garden/01 - Neon Rain.mp3', data: Buffer.from('a') },
    { name: 'Kira Voss - Chrome Garden/02 - Paper Planes.mp3', data: Buffer.from('b'), deflate: true },
    { name: '2024 - сборник/03 - Track.mp3', data: Buffer.from('c') },
  ]);

  const file = new File([zip], 'album.zip', { type: 'application/zip' });
  const result = await extractAudioFromZip(file);

  assert.equal(result.artistHints['01 - Neon Rain.mp3'], 'Kira Voss');
  assert.equal(result.artistHints['02 - Paper Planes.mp3'], 'Kira Voss');
  assert.equal(result.artistHints['03 - Track.mp3'], undefined, 'числовая папка — не исполнитель');
});
