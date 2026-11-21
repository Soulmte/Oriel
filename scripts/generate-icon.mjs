/**
 * Generates the 1024x1024 source icon used by `npm run icon`
 * (which calls `tauri icon` to produce .ico/.icns/all PNG sizes).
 *
 * No image dependencies: a tiny SDF rasterizer + hand-rolled PNG encoder.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const SIZE = 1024;
const pixels = Buffer.alloc(SIZE * SIZE * 4);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const lerp = (a, b, t) => a + (b - a) * t;

function blend(x, y, r, g, b, alpha) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || alpha <= 0) return;
  const index = (y * SIZE + x) * 4;
  const srcA = clamp(alpha, 0, 1);
  const dstA = pixels[index + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;

  pixels[index] = Math.round(
    (r * srcA + pixels[index] * dstA * (1 - srcA)) / outA,
  );
  pixels[index + 1] = Math.round(
    (g * srcA + pixels[index + 1] * dstA * (1 - srcA)) / outA,
  );
  pixels[index + 2] = Math.round(
    (b * srcA + pixels[index + 2] * dstA * (1 - srcA)) / outA,
  );
  pixels[index + 3] = Math.round(outA * 255);
}

function roundedRectSdf(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - (halfW - radius);
  const qy = Math.abs(y - cy) - (halfH - radius);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
    Math.min(Math.max(qx, qy), 0) -
    radius
  );
}

// Backdrop: rounded blue square with a slight vertical gradient and a soft
// top-left sheen, close to the macOS app icon language.
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const sdf = roundedRectSdf(x, y, SIZE / 2, SIZE / 2, 436, 436, 214);
    const coverage = clamp(0.5 - sdf, 0, 1);
    if (coverage <= 0) continue;

    const t = clamp((y - 76) / 872, 0, 1);
    let r = lerp(96, 8, t);
    let g = lerp(178, 104, t);
    let b = lerp(255, 250, t);

    const sheen = clamp(1 - Math.hypot(x - 300, y - 240) / 620, 0, 1) * 0.22;
    r = lerp(r, 255, sheen);
    g = lerp(g, 255, sheen);
    b = lerp(b, 255, sheen);

    blend(x, y, r, g, b, coverage);
  }
}

// Folder tab.
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const sdf = roundedRectSdf(x, y, 402, 386, 162, 82, 38);
    const coverage = clamp(0.5 - sdf, 0, 1);
    if (coverage > 0) blend(x, y, 255, 255, 255, coverage * 0.96);
  }
}

// Folder body with a subtle bottom tint.
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const sdf = roundedRectSdf(x, y, 512, 606, 302, 212, 46);
    const coverage = clamp(0.5 - sdf, 0, 1);
    if (coverage <= 0) continue;
    const t = clamp((y - 394) / 424, 0, 1);
    blend(x, y, lerp(255, 236, t), lerp(255, 242, t), lerp(255, 250, t), coverage * 0.97);
  }
}

// Highlight along the folder opening.
for (let y = 470; y < 486; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const sdf = roundedRectSdf(x, y, 512, 478, 290, 8, 8);
    const coverage = clamp(0.5 - sdf, 0, 1);
    if (coverage > 0) blend(x, y, 255, 255, 255, coverage * 0.22);
  }
}

// --- Minimal PNG encoder -------------------------------------------------

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const stride = SIZE * 4;
const raw = Buffer.alloc((stride + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (stride + 1)] = 0;
  pixels.copy(
    raw,
    y * (stride + 1) + 1,
    y * stride,
    (y + 1) * stride,
  );
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const output = resolve(process.cwd(), "src-tauri/app-icon.png");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, png);
console.log(`Wrote ${output} (${(png.length / 1024).toFixed(1)} KB)`);
