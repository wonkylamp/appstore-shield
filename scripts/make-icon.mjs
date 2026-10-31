// The plugin directory takes its listing icon from the first submission only, so the icon is
// generated from code (no image tools or dependencies) and committed at .claude-plugin/icon.png.
// Run: node scripts/make-icon.mjs
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SIZE = 512;
const SS = 4;
const BG = [29, 78, 216];
const FG = [255, 255, 255];

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function inShield(u, v) {
  const d = Math.abs(u - 0.5);
  if (v < 0.17 || v > 0.87) return false;
  if (v <= 0.55) return d <= 0.28;
  const k = (v - 0.55) / 0.32;
  return d <= 0.28 * Math.sqrt(Math.max(0, 1 - k * k));
}

function inCheck(u, v) {
  return segDist(u, v, 0.37, 0.5, 0.47, 0.62) < 0.04 || segDist(u, v, 0.47, 0.62, 0.65, 0.39) < 0.04;
}

function inRoundedSquare(u, v) {
  const r = 0.18;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  return Math.hypot(u - cx, v - cy) <= r;
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const u = (x + (sx + 0.5) / SS) / SIZE;
        const v = (y + (sy + 0.5) / SS) / SIZE;
        if (!inRoundedSquare(u, v)) continue;
        const c = inShield(u, v) && !inCheck(u, v) ? FG : BG;
        r += c[0];
        g += c[1];
        b += c[2];
        a += 255;
      }
    }
    const n = SS * SS;
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    // Premultiplied sums divided by covered samples keep edge colour true; alpha carries coverage.
    const covered = a / 255 || 1;
    raw[o] = Math.round(r / covered);
    raw[o + 1] = Math.round(g / covered);
    raw[o + 2] = Math.round(b / covered);
    raw[o + 3] = Math.round(a / n);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "icon.png");
writeFileSync(out, png);
console.log(`wrote ${path.relative(process.cwd(), out)} (${png.length} bytes)`);
