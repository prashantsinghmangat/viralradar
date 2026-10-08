// Draws the app icons.
//
//   npm run icons
//
// A home-screen icon has to be a PNG — browsers will not take the SVG the
// favicon uses. Rather than add an image library for four small files, this
// draws them pixel by pixel and writes the PNG by hand: node:zlib does the
// compression, which is the only hard part.
//
// The shape is the same one in the favicon: a filled disc, a ring, and a dot.
// A radar, more or less.
//
// Two kinds are produced:
//   icon-N.png           the disc on transparency, for anywhere a plain icon fits
//   icon-maskable-N.png  full-bleed background, artwork inside the middle 80%,
//                        because Android crops icons to whatever shape the
//                        launcher uses and anything outside that circle is lost

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'icons');

const BRAND = [0x2a, 0x78, 0xd6]; // the same blue as the favicon and theme-color
const WHITE = [0xff, 0xff, 0xff];

// ---------- PNG ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An RGBA pixel buffer as a PNG. */
export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;  // bits per channel
  header[9] = 6;  // colour type 6: RGBA
  // 10, 11, 12 are compression, filter and interlace: all 0, the only values
  // anything supports.

  // Every row is prefixed with its filter type. 0 means "no filter", which
  // compresses a little worse and is much easier to be sure about.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const from = y * width * 4;
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, from, from + width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- the drawing ----------

/**
 * How much of a pixel is covered, by sampling it in a grid. Without this the
 * curves come out as staircases, which looks cheap at 192px and worse at 48.
 */
function coverage(x, y, inside, samples = 4) {
  let hits = 0;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      if (inside(x + (sx + 0.5) / samples, y + (sy + 0.5) / samples)) hits++;
    }
  }
  return hits / (samples * samples);
}

/** Paint one colour onto a pixel, in proportion to how much of it is covered. */
function blend(rgba, index, colour, alpha) {
  if (alpha <= 0) return;
  const existing = rgba[index + 3] / 255;
  const out = alpha + existing * (1 - alpha);
  for (let c = 0; c < 3; c++) {
    rgba[index + c] = Math.round((colour[c] * alpha + rgba[index + c] * existing * (1 - alpha)) / out);
  }
  rgba[index + 3] = Math.round(out * 255);
}

export function drawIcon(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4); // transparent
  const mid = size / 2;

  // A maskable icon can be cropped to any shape, so the background fills the
  // whole square and the artwork stays inside the middle 80%.
  const scale = maskable ? 0.8 : 1;
  const discR = (maskable ? 0.5 : 0.47) * size * scale;
  const ringR = 0.27 * size * scale;
  const ringW = 0.075 * size * scale;
  const dotR = 0.085 * size * scale;

  const dist = (x, y) => Math.hypot(x - mid, y - mid);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      if (maskable) {
        // Full bleed: no transparency to crop away.
        rgba[i] = BRAND[0]; rgba[i + 1] = BRAND[1]; rgba[i + 2] = BRAND[2]; rgba[i + 3] = 255;
      } else {
        blend(rgba, i, BRAND, coverage(x, y, (px, py) => dist(px, py) <= discR));
      }

      blend(rgba, i, WHITE, coverage(x, y, (px, py) => {
        const d = dist(px, py);
        return d >= ringR - ringW / 2 && d <= ringR + ringW / 2;
      }));
      blend(rgba, i, WHITE, coverage(x, y, (px, py) => dist(px, py) <= dotR));
    }
  }
  return rgba;
}

export const ICONS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-192.png', size: 192, maskable: true },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
];

export function makeIcons(dir = OUT_DIR) {
  mkdirSync(dir, { recursive: true });
  return ICONS.map(({ file, size, maskable }) => {
    const png = encodePng(size, size, drawIcon(size, { maskable }));
    writeFileSync(join(dir, file), png);
    return { file, size, bytes: png.length };
  });
}

if (process.argv[1] && process.argv[1].endsWith('make-icons.mjs')) {
  for (const { file, size, bytes } of makeIcons()) {
    console.log(`  ${file.padEnd(26)} ${size}x${size}  ${(bytes / 1024).toFixed(1)} KB`);
  }
}
