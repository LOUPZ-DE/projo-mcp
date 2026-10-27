// Generiert assets/icon.png (256x256 RGBA) ohne externe Dependencies:
// dunkelblauer Rounded-Square-Hintergrund, sky-blauer Ring, weißer Kern —
// Farben passend zur Login-/Info-Seite (#0f172a, #38bdf8, #e2e8f0).
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const S = 256;
const buf = Buffer.alloc(S * S * 4);

function setPx(x, y, r, g, b, a = 255) {
  const i = (y * S + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
}

function inRoundRect(x, y, pad, rad) {
  const x0 = pad, y0 = pad, x1 = S - pad - 1, y1 = S - pad - 1;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + rad, Math.min(x, x1 - rad));
  const cy = Math.max(y0 + rad, Math.min(y, y1 - rad));
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad ** 2;
}

const CX = 128, CY = 128, RING_R = 72, RING_W = 16, DOT_R = 34;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!inRoundRect(x, y, 8, 52)) { setPx(x, y, 0, 0, 0, 0); continue; }
    setPx(x, y, 15, 23, 42); // #0f172a
    const d = Math.hypot(x - CX, y - CY);
    if (d > RING_R - RING_W && d <= RING_R) setPx(x, y, 56, 189, 248); // #38bdf8
    if (d <= DOT_R) setPx(x, y, 226, 232, 240); // #e2e8f0
  }
}

// ── PNG-Encoding (Filter 0 pro Scanline, IDAT = zlib-deflate) ──────────────
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;  // Bit depth
ihdr[9] = 6;  // Color type RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = new URL('../assets/icon.png', import.meta.url).pathname;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`geschrieben: ${out} (${png.length} Bytes)`);
