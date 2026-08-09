#!/usr/bin/env node
/**
 * scripts/make-icons.mjs
 *
 * Zero-dependency Node script that writes the four placeholder toolbar
 * icons by emitting raw PNG chunks (IHDR/IDAT/IEND, deflated via
 * node:zlib) — a rounded-square gradient glyph using the same
 * blue -> orange gradient cue as the widget (GRADIENT_FROM/GRADIENT_TO in
 * src/shared/constants.js). No Sarvam logo, monogram, or wordmark — this is
 * a generic abstract mark only.
 *
 * Keeps binary icon assets reproducible from source instead of checking in
 * mystery blobs. Run with: node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(__dirname, '..', 'icons');

const SIZES = [16, 32, 48, 128];

// Same hex values as src/shared/constants.js GRADIENT_FROM / GRADIENT_TO.
const GRADIENT_FROM = [0x2f, 0x6b, 0xff]; // #2F6BFF
const GRADIENT_TO = [0xff, 0x8a, 0x34]; // #FF8A34

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

/**
 * Renders a rounded-square diagonal-gradient glyph with a simple lighter
 * "play/soundwave" cue notch, as raw RGBA rows.
 * @param {number} size
 * @returns {Buffer} raw (unfiltered) RGBA pixel data, one 0x00 filter byte
 *   prepended per scanline, ready to deflate as PNG IDAT.
 */
function renderRGBA(size) {
  const radius = Math.max(2, Math.round(size * 0.22));
  const rowBytes = size * 4;
  const raw = Buffer.alloc((rowBytes + 1) * size);

  const isInsideRoundedSquare = (x, y) => {
    // Distance-based rounded-rect test against the nearest corner circle.
    const cx = Math.min(Math.max(x, radius), size - 1 - radius);
    const cy = Math.min(Math.max(y, radius), size - 1 - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius + 0.5;
  };

  for (let y = 0; y < size; y++) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0; // filter type 0 (None) for this scanline
    for (let x = 0; x < size; x++) {
      const offset = rowStart + 1 + x * 4;
      const inside = isInsideRoundedSquare(x, y);

      if (!inside) {
        // Transparent outside the rounded square.
        raw[offset] = 0;
        raw[offset + 1] = 0;
        raw[offset + 2] = 0;
        raw[offset + 3] = 0;
        continue;
      }

      const t = (x + y) / (2 * (size - 1));
      let r = lerp(GRADIENT_FROM[0], GRADIENT_TO[0], t);
      let g = lerp(GRADIENT_FROM[1], GRADIENT_TO[1], t);
      let b = lerp(GRADIENT_FROM[2], GRADIENT_TO[2], t);

      // Simple abstract "sound bar" glyph: three vertical bars of varying
      // height, drawn in a lightened tone, centered in the square.
      const barW = Math.max(1, Math.round(size * 0.11));
      const gap = Math.max(1, Math.round(size * 0.09));
      const totalW = barW * 3 + gap * 2;
      const startX = Math.round((size - totalW) / 2);
      const heights = [0.4, 0.75, 0.55];
      const baseY = Math.round(size * 0.78);

      let inBar = false;
      for (let i = 0; i < 3; i++) {
        const barX0 = startX + i * (barW + gap);
        const barX1 = barX0 + barW;
        const barH = Math.round(size * heights[i]);
        const barY0 = baseY - barH;
        if (x >= barX0 && x < barX1 && y >= barY0 && y <= baseY) {
          inBar = true;
          break;
        }
      }

      if (inBar) {
        r = Math.min(255, r + 70);
        g = Math.min(255, g + 70);
        b = Math.min(255, b + 70);
      }

      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = 255;
    }
  }

  return raw;
}

function encodePng(size) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0); // width
  ihdrData.writeUInt32BE(size, 4); // height
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = chunk('IHDR', ihdrData);

  const raw = renderRGBA(size);
  const idatData = deflateSync(raw);
  const idat = chunk('IDAT', idatData);

  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function main() {
  mkdirSync(ICONS_DIR, { recursive: true });
  for (const size of SIZES) {
    const png = encodePng(size);
    const outPath = join(ICONS_DIR, `icon${size}.png`);
    writeFileSync(outPath, png);
    console.log(`wrote ${outPath} (${png.length} bytes)`);
  }
}

main();
