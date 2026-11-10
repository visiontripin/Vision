#!/usr/bin/env node
/**
 * Генерирует PNG-иконки для PWA без зависимостей (zlib + CRC32 из node).
 *
 *   node scripts/make-icons.mjs
 *
 * Иконки — часть репозитория (apps/web/public), скрипт нужен, чтобы их можно
 * было пересобрать и не тащить в проект sharp/canvas.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/public');

const BG = [255, 90, 31]; // #ff5a1f — акцент приложения
const INK = [8, 8, 11]; // #08080b

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Простейший растеризатор: покрытие пикселя по аналитической форме. */
function render(size, { padding, rounded }) {
  const px = Buffer.alloc(size * size * 4);
  const radius = rounded ? size * 0.22 : 0;
  const pad = size * padding;
  const inner = size - pad * 2;

  // три «полосы» волны: x, ширина, высота (доли внутреннего квадрата)
  const bars = [
    { x: 0.2, w: 0.13, h: 0.34 },
    { x: 0.435, w: 0.13, h: 0.62 },
    { x: 0.67, w: 0.13, h: 0.46 },
  ];

  const inRounded = (x, y) => {
    if (!rounded) return true;
    const r = radius;
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= r && x <= size - r) || (y >= r && y <= size - r);
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const inside = inRounded(x + 0.5, y + 0.5);
      if (!inside) {
        px[i + 3] = 0;
        continue;
      }

      let color = BG;
      const nx = (x + 0.5 - pad) / inner;
      const ny = (y + 0.5 - pad) / inner;
      for (const bar of bars) {
        const half = bar.h / 2;
        if (nx >= bar.x && nx <= bar.x + bar.w && ny >= 0.5 - half && ny <= 0.5 + half) color = INK;
      }

      px[i] = color[0];
      px[i + 1] = color[1];
      px[i + 2] = color[2];
      px[i + 3] = 255;
    }
  }

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, padding: 0.14, rounded: true },
  { file: 'icon-512.png', size: 512, padding: 0.14, rounded: true },
  // maskable: без скруглений и с большим отступом — Android обрежет сам
  { file: 'icon-maskable-512.png', size: 512, padding: 0.24, rounded: false },
];

for (const target of targets) {
  const png = render(target.size, target);
  writeFileSync(path.join(OUT_DIR, target.file), png);
  console.log(`✓ ${target.file} — ${(png.length / 1024).toFixed(1)} КБ`);
}
