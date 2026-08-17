'use strict';
// Generates the PopShield icon set. No image library: PNG is a handful of
// length-prefixed CRC'd chunks around a zlib stream, so node's own zlib is
// enough. Rerun to regenerate; the icons are output, not hand-edited assets.
//   node tools/make-icons.cjs <output-dir>
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const outDir = process.argv[2];
if (!outDir) { console.error('usage: node make-icons.cjs <output-dir>'); process.exit(2); }

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b; raw[offset + 3] = a;
      offset += 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

// A shield outline with a diagonal bar through it - "blocked".
function shield(x, y, size) {
  const u = (x + 0.5) / size;
  const v = (y + 0.5) / size;
  const cx = 0.5;
  const halfWidth = 0.36 * (v < 0.55 ? 1 : 1 - (v - 0.55) / 0.42);
  const inside = v >= 0.1 && v <= 0.94 && Math.abs(u - cx) <= Math.max(halfWidth, 0);

  if (!inside) return [0, 0, 0, 0];

  const t = (u - 0.14) * 0.6 + v * 0.4;
  const r = lerp(255, 141, Math.min(1, Math.max(0, t)));
  const g = lerp(49, 77, Math.min(1, Math.max(0, t)));
  const b = lerp(88, 255, Math.min(1, Math.max(0, t)));

  // Slash: distance to the line u + v = 1 (top-right to bottom-left).
  const slash = Math.abs(u + v - 1) / Math.SQRT2;
  if (slash < 0.055) return [12, 10, 18, 255];

  return [r, g, b, 255];
}

fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, png(size, shield));
  console.log(`  wrote ${file} (${fs.statSync(file).size} bytes)`);
}
