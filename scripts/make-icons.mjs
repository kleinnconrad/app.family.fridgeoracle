// Generates the app icons (a white fridge on a green background) as PNG files.
// No dependencies: pixels are computed directly and encoded with node:zlib.
// Usage: npm run icons

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const GREEN = [0x2f, 0x6f, 0x4f, 255];
const WHITE = [255, 255, 255, 255];
const SUPERSAMPLING = 4;

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

// Color at a point in unit coordinates (0..1). `inset` shrinks the motif for the maskable icon.
function colorAt(x, y, inset, rounded) {
  if (rounded && !insideRoundedRect(x, y, 0, 0, 1, 1, 0.18)) return [0, 0, 0, 0];
  // Map into the motif area
  const u = (x - inset) / (1 - 2 * inset);
  const v = (y - inset) / (1 - 2 * inset);
  if (!insideRoundedRect(u, v, 0.27, 0.12, 0.73, 0.88, 0.07)) return GREEN;
  const divider = v > 0.395 && v < 0.425;
  const upperHandle = u > 0.34 && u < 0.38 && v > 0.2 && v < 0.33;
  const lowerHandle = u > 0.34 && u < 0.38 && v > 0.49 && v < 0.66;
  return divider || upperHandle || lowerHandle ? GREEN : WHITE;
}

function render(size, { inset = 0, rounded = false } = {}) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < SUPERSAMPLING; sy++) {
        for (let sx = 0; sx < SUPERSAMPLING; sx++) {
          const color = colorAt(
            (px + (sx + 0.5) / SUPERSAMPLING) / size,
            (py + (sy + 0.5) / SUPERSAMPLING) / size,
            inset,
            rounded,
          );
          // Premultiplied alpha, so that transparent samples do not darken the edge
          for (let c = 0; c < 3; c++) sum[c] += (color[c] * color[3]) / 255;
          sum[3] += color[3];
        }
      }
      const samples = SUPERSAMPLING ** 2;
      const alpha = sum[3] / samples;
      const offset = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) pixels[offset + c] = alpha ? Math.round(((sum[c] / samples) * 255) / alpha) : 0;
      pixels[offset + 3] = Math.round(alpha);
    }
  }
  return encodePng(size, size, pixels);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type RGBA
  // Each row starts with filter type 0 (none)
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = new URL("../app/icons/", import.meta.url);
mkdirSync(outDir, { recursive: true });
writeFileSync(new URL("icon-192.png", outDir), render(192, { rounded: true }));
writeFileSync(new URL("icon-512.png", outDir), render(512, { rounded: true }));
// Maskable: full-bleed background, motif inside the safe zone (inner 80 %)
writeFileSync(new URL("icon-maskable-512.png", outDir), render(512, { inset: 0.1 }));
console.log("Icons written to app/icons/");
