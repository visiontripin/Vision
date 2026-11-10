import { open } from 'node:fs/promises';

/**
 * Извлечение метаданных и обложки из аудиофайла без внешних зависимостей.
 * Поддержка: ID3v2.3/2.4 (mp3, в т.ч. внутри WAV-чанка), Vorbis comments и
 * PICTURE (flac, ogg), INFO-чанки WAV, ilst-атомы MP4/M4A.
 *
 * Парсер намеренно «мягкий»: любые сомнительные данные игнорируются, а не
 * приводят к ошибке загрузки. Приоритет — безопасность и предсказуемость.
 */

const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 300;
const HEAD_BYTES = 2 * 1024 * 1024;
const TAIL_BYTES = 128 * 1024;

const clean = (value) => {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, MAX_TEXT) : null;
};

const readLatin1 = (buffer, start, end) => buffer.toString('latin1', start, end);
const readUtf8 = (buffer, start, end) => buffer.toString('utf8', start, end);

/* ---------------------------------- ID3 ---------------------------------- */

const ID3_TEXT_FRAMES = {
  TIT2: 'title',
  TT2: 'title',
  TPE1: 'artist',
  TP1: 'artist',
  TALB: 'album',
  TAL: 'album',
  TCON: 'genre',
  TCO: 'genre',
  TDRC: 'year',
  TYER: 'year',
  TYE: 'year',
};

function decodeId3Text(buffer, start, end) {
  if (end <= start) return null;
  const encoding = buffer[start];
  const body = buffer.subarray(start + 1, end);

  try {
    if (encoding === 1) {
      if (body[0] === 0xff && body[1] === 0xfe) return body.toString('utf16le', 2);
      if (body[0] === 0xfe && body[1] === 0xff) {
        const swapped = Buffer.from(body.subarray(2));
        swapped.swap16();
        return swapped.toString('utf16le');
      }
      return body.toString('utf16le');
    }
    if (encoding === 2) {
      const swapped = Buffer.from(body);
      swapped.swap16();
      return swapped.toString('utf16le');
    }
    if (encoding === 3) return body.toString('utf8');
    return body.toString('latin1');
  } catch {
    return null;
  }
}

function findTerminator(buffer, start, encoding, end) {
  if (encoding === 1 || encoding === 2) {
    for (let i = start; i + 1 < end; i += 2) {
      if (buffer[i] === 0 && buffer[i + 1] === 0) return i;
    }
    return end;
  }
  for (let i = start; i < end; i += 1) if (buffer[i] === 0) return i;
  return end;
}

function parseId3(buffer, offset = 0, result = {}) {
  if (buffer.length < offset + 10) return result;
  if (readLatin1(buffer, offset, offset + 3) !== 'ID3') return result;

  const major = buffer[offset + 3];
  if (major !== 3 && major !== 4) return result;

  const size = ((buffer[offset + 6] & 0x7f) << 21) |
    ((buffer[offset + 7] & 0x7f) << 14) |
    ((buffer[offset + 8] & 0x7f) << 7) |
    (buffer[offset + 9] & 0x7f);

  let position = offset + 10;
  const end = Math.min(buffer.length, position + size);
  const headerSize = major === 4 ? 10 : 10;

  while (position + headerSize <= end) {
    const frameId = readLatin1(buffer, position, position + 4);
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

    const rawSize = buffer.readUInt32BE(position + 4);
    const frameSize =
      major === 4
        ? ((rawSize & 0x7f000000) >> 3) | ((rawSize & 0x7f0000) >> 2) | ((rawSize & 0x7f00) >> 1) | (rawSize & 0x7f)
        : rawSize;

    if (frameSize <= 0 || position + headerSize + frameSize > end) break;
    const bodyStart = position + headerSize;
    const bodyEnd = bodyStart + frameSize;

    const field = ID3_TEXT_FRAMES[frameId];
    if (field) {
      const text = clean(decodeId3Text(buffer, bodyStart, bodyEnd));
      if (text && !result[field]) result[field] = text;
    }

    if (frameId === 'APIC' && !result.cover) {
      const encoding = buffer[bodyStart];
      let cursor = bodyStart + 1;

      const mimeEnd = findTerminator(buffer, cursor, 0, bodyEnd);
      const mime = readLatin1(buffer, cursor, mimeEnd);
      cursor = mimeEnd + 1;

      cursor += 1; // picture type
      const descEnd = findTerminator(buffer, cursor, encoding, bodyEnd);
      cursor = descEnd + (encoding === 1 || encoding === 2 ? 2 : 1);

      if (cursor < bodyEnd) {
        const data = buffer.subarray(cursor, bodyEnd);
        if (data.length > 64 && data.length <= MAX_COVER_BYTES) {
          result.cover = { mime: mime || 'image/jpeg', data: Buffer.from(data) };
        }
      }
    }

    if (frameId === 'TXXX' && !result.genre) {
      const text = clean(decodeId3Text(buffer, bodyStart, bodyEnd));
      if (text) {
        const match = /^GENRE[=:]\s*(.+)$/i.exec(text);
        if (match) result.genre = clean(match[1]);
      }
    }

    position = bodyEnd;
  }

  return result;
}

/* ---------------------------------- FLAC --------------------------------- */

function parseFlac(buffer, result) {
  if (readLatin1(buffer, 0, 4) !== 'fLaC') return result;

  let position = 4;
  while (position + 4 <= buffer.length) {
    const header = buffer[position];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = buffer.readUIntBE(position + 1, 3);
    const bodyStart = position + 4;
    const bodyEnd = bodyStart + length;
    if (length < 0 || bodyEnd > buffer.length) break;

    if (type === 4) parseVorbisComment(buffer.subarray(bodyStart, bodyEnd), result);
    if (type === 6) parseFlacPicture(buffer.subarray(bodyStart, bodyEnd), result);

    if (isLast) break;
    position = bodyEnd;
  }
  return result;
}

function parseVorbisComment(buffer, result) {
  try {
    let cursor = 0;
    const vendorLength = buffer.readUInt32LE(cursor);
    cursor += 4 + vendorLength;
    if (cursor + 4 > buffer.length) return;
    const count = buffer.readUInt32LE(cursor);
    cursor += 4;

    const mapping = {
      TITLE: 'title',
      ARTIST: 'artist',
      ALBUM: 'album',
      GENRE: 'genre',
      DATE: 'year',
    };

    for (let i = 0; i < count && cursor + 4 <= buffer.length; i += 1) {
      const length = buffer.readUInt32LE(cursor);
      cursor += 4;
      if (length <= 0 || cursor + length > buffer.length) break;
      const entry = readUtf8(buffer, cursor, cursor + length);
      cursor += length;

      const separator = entry.indexOf('=');
      if (separator <= 0) continue;
      const key = entry.slice(0, separator).toUpperCase();
      const value = clean(entry.slice(separator + 1));
      const field = mapping[key];
      if (field && value && !result[field]) result[field] = value;
    }
  } catch {
    /* повреждённые комментарии игнорируем */
  }
}

function parseFlacPicture(buffer, result) {
  try {
    let cursor = 0;
    const mimeLength = buffer.readUInt32BE(cursor);
    cursor += 4;
    const mime = readLatin1(buffer, cursor, cursor + mimeLength);
    cursor += mimeLength;

    const descLength = buffer.readUInt32BE(cursor);
    cursor += 4 + descLength;

    cursor += 16; // width, height, depth, colors
    if (cursor + 4 > buffer.length) return;
    const dataLength = buffer.readUInt32BE(cursor);
    cursor += 4;

    if (dataLength > 64 && dataLength <= MAX_COVER_BYTES && cursor + dataLength <= buffer.length) {
      if (!result.cover) {
        result.cover = {
          mime: mime || 'image/jpeg',
          data: Buffer.from(buffer.subarray(cursor, cursor + dataLength)),
        };
      }
    }
  } catch {
    /* ignore */
  }
}

/* ----------------------------------- WAV ---------------------------------- */

function parseWav(buffer, result) {
  if (readLatin1(buffer, 0, 4) !== 'RIFF' || readLatin1(buffer, 8, 12) !== 'WAVE') return result;
  const end = Math.min(buffer.length, buffer.readUInt32LE(4) + 8);

  let position = 12;
  while (position + 8 <= end) {
    const chunkId = readLatin1(buffer, position, position + 4);
    const size = buffer.readUInt32LE(position + 4);
    const bodyStart = position + 8;
    const bodyEnd = Math.min(end, bodyStart + size);
    if (size < 0 || bodyStart > end) break;

    if (chunkId === 'LIST' && readLatin1(buffer, bodyStart, bodyStart + 4) === 'INFO') {
      let cursor = bodyStart + 4;
      while (cursor + 8 <= bodyEnd) {
        const id = readLatin1(buffer, cursor, cursor + 4);
        const length = buffer.readUInt32LE(cursor + 4);
        const valueStart = cursor + 8;
        const valueEnd = Math.min(bodyEnd, valueStart + length);
        const value = clean(readUtf8(buffer, valueStart, valueEnd));
        if (value) {
          if (id === 'INAM' && !result.title) result.title = value;
          if (id === 'IART' && !result.artist) result.artist = value;
          if (id === 'IPRD' && !result.album) result.album = value;
          if (id === 'IGNR' && !result.genre) result.genre = value;
          if (id === 'ICRD' && !result.year) result.year = value;
        }
        cursor = valueStart + length + (length % 2);
      }
    }

    if (chunkId === 'id3 ' || chunkId === 'ID3 ') {
      parseId3(buffer.subarray(bodyStart, bodyEnd), 0, result);
    }

    position = bodyStart + size + (size % 2);
  }
  return result;
}

/* ----------------------------------- MP4 ---------------------------------- */

function parseIlst(buffer, ilstOffset, result) {
  let position = ilstOffset + 8; // пропускаем сам атом 'ilst'
  const end = Math.min(buffer.length, ilstOffset + buffer.readUInt32BE(ilstOffset));

  const mapping = {
    '\u00a9nam': 'title',
    '\u00a9ART': 'artist',
    '\u00a9alb': 'album',
    '\u00a9gen': 'genre',
    '\u00a9day': 'year',
    gnre: 'genre',
  };

  while (position + 8 <= end) {
    const size = buffer.readUInt32BE(position);
    if (size < 8 || position + size > end) break;
    const name = readLatin1(buffer, position + 4, position + 8);
    const bodyStart = position + 8;
    const bodyEnd = position + size;

    // внутри item — атом 'data'
    let cursor = bodyStart;
    while (cursor + 8 <= bodyEnd) {
      const dataSize = buffer.readUInt32BE(cursor);
      if (dataSize < 8 || cursor + dataSize > bodyEnd) break;
      const dataName = readLatin1(buffer, cursor + 4, cursor + 8);
      if (dataName === 'data') {
        const payloadStart = cursor + 16; // type(4) + locale(4)
        const payloadEnd = cursor + dataSize;
        if (name === 'covr' && !result.cover) {
          const data = buffer.subarray(payloadStart, payloadEnd);
          if (data.length > 64 && data.length <= MAX_COVER_BYTES) {
            const isPng = data[0] === 0x89 && data[1] === 0x50;
            result.cover = { mime: isPng ? 'image/png' : 'image/jpeg', data: Buffer.from(data) };
          }
        } else {
          const field = mapping[name];
          const value = clean(readUtf8(buffer, payloadStart, payloadEnd));
          if (field && value && !result[field]) result[field] = value;
        }
      }
      cursor += dataSize;
    }

    position = bodyEnd;
  }
  return result;
}

function parseMp4(buffer, result) {
  if (readLatin1(buffer, 4, 8) !== 'ftyp') return result;
  const index = buffer.indexOf('ilst', 0, 'latin1');
  if (index < 4) return result;
  try {
    // 'ilst' находится внутри атома, начинающегося на 4 байта раньше
    return parseIlst(buffer, index - 4, result);
  } catch {
    return result;
  }
}

/* -------------------------------- публичное ------------------------------- */

export function parseTags(head, tail = Buffer.alloc(0)) {
  const result = { title: null, artist: null, album: null, genre: null, year: null, cover: null };

  const magic = readLatin1(head, 0, 4);
  if (magic.startsWith('ID3')) parseId3(head, 0, result);
  else if (magic === 'fLaC') parseFlac(head, result);
  else if (magic === 'RIFF') parseWav(head, result);
  else if (/^(OggS)/.test(magic)) parseVorbisInOgg(head, result);
  else if (readLatin1(head, 4, 8) === 'ftyp') parseMp4(head, result);

  // MP4/M4A: moov может лежать в конце файла
  if (!result.title && tail.length) {
    if (readLatin1(tail, 4, 8) === 'ftyp' || tail.includes('ilst')) parseMp4(tail, result);
  }

  // ID3v1 в хвосте (128 байт) — грубый, но иногда единственный источник
  if (!result.title && tail.length >= 128) {
    const start = tail.length - 128;
    if (readLatin1(tail, start, start + 3) === 'TAG') {
      const title = clean(readLatin1(tail, start + 3, start + 33));
      const artist = clean(readLatin1(tail, start + 33, start + 63));
      const album = clean(readLatin1(tail, start + 63, start + 93));
      const year = clean(readLatin1(tail, start + 93, start + 97));
      if (title) result.title = title;
      if (artist) result.artist = artist;
      if (album) result.album = album;
      if (year) result.year = year;
    }
  }

  return result;
}

/** Ogg: ищем заголовок комментариев в первых страницах (упрощённо). */
function parseVorbisInOgg(buffer, result) {
  const marker = buffer.indexOf('vorbis', 0, 'latin1');
  const opus = buffer.indexOf('OpusTags', 0, 'latin1');
  const start = marker >= 0 ? marker : opus;
  if (start < 0) return result;

  let cursor = start;
  while (cursor < buffer.length && buffer[cursor] !== 0x03) cursor += 1; // framing bit
  if (cursor >= buffer.length) return result;
  parseVorbisComment(buffer.subarray(cursor + 1), result);
  return result;
}

/** Читает начало и конец файла и отдаёт теги. Никогда не бросает. */
export async function readTags(filePath) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const { size } = await handle.stat();
    const headLength = Math.min(size, HEAD_BYTES);
    const head = Buffer.alloc(headLength);
    await handle.read(head, 0, headLength, 0);

    let tail = Buffer.alloc(0);
    if (size > headLength) {
      const tailLength = Math.min(size - headLength, TAIL_BYTES);
      tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, size - tailLength);
    }

    return parseTags(head, tail);
  } catch {
    return { title: null, artist: null, album: null, genre: null, year: null, cover: null };
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function isSupportedCover(mime) {
  return ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(String(mime).toLowerCase());
}

export const COVER_LIMIT = MAX_COVER_BYTES;
