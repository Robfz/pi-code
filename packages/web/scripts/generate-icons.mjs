#!/usr/bin/env node
/**
 * Generates the PWA icons in `public/` with Node built-ins only (zlib for PNG compression):
 * a monospace-style "π" glyph and a prompt cursor on a dark square.
 *
 *   node scripts/generate-icons.mjs
 *
 * - `icons/icon-{192,512}.png`: rounded square, transparent corners (purpose "any").
 * - `icons/maskable-{192,512}.png`: full-bleed background, glyph inside the safe zone.
 * - `icons/apple-touch-icon.png` (180): full bleed; iOS rounds it.
 * - `favicon.svg`: the same drawing as vector.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const BG = [0x18, 0x18, 0x1b]; // zinc-900, reads as "dark" next to the #0d0d0d theme
const FG = [0xfa, 0xfa, 0xfa];
const ACCENT = [0x34, 0xd3, 0x99]; // emerald-400

/**
 * Glyph in a 100×100 design space, as rectangles (x, y, w, h, color). The "π": a top bar and
 * two legs; the right leg ends in a small foot like a monospace π, followed by a cursor.
 */
const GLYPH = [
  { x: 14, y: 28, w: 52, h: 9, color: FG }, // bar
  { x: 24, y: 37, w: 9, h: 38, color: FG }, // left leg
  { x: 46, y: 37, w: 9, h: 33, color: FG }, // right leg
  { x: 46, y: 66, w: 15, h: 9, color: FG }, // right foot
  { x: 14, y: 28, w: 6, h: 14, color: FG }, // left serif (drop from the bar)
  { x: 70, y: 68, w: 16, h: 7, color: ACCENT }, // prompt cursor
];

// ---------------------------------------------------------------------------
// Rasterizer: 4×4 supersampling over shape tests.

/** Inside a rounded rectangle? */
function inRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/**
 * @param size   output pixels
 * @param opts.radius  background corner radius in design units (0 = full bleed square)
 * @param opts.scale   glyph scale around the center (maskable icons shrink into the safe zone)
 */
function render(size, { radius, scale }) {
  const SS = 4;
  const rgba = new Uint8Array(size * size * 4);
  const unit = 100 / size;
  const glyph = GLYPH.map((r) => ({
    ...r,
    x: 50 + (r.x - 50) * scale,
    y: 50 + (r.y - 50) * scale,
    w: r.w * scale,
    h: r.h * scale,
  }));

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let a = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * unit;
          const y = (py + (sy + 0.5) / SS) * unit;
          if (radius > 0 && !inRoundedRect(x, y, 0, 0, 100, 100, radius)) continue;
          let color = BG;
          for (const rect of glyph) {
            if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) {
              color = rect.color;
            }
          }
          a++;
          r += color[0];
          g += color[1];
          b += color[2];
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
      }
      rgba[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return rgba;
}

// ---------------------------------------------------------------------------
// PNG encoder (RGBA, 8-bit, filter 0).

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------

function svg() {
  const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  const rects = GLYPH.map(
    (r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${hex(r.color)}"/>`,
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>pi-code</title><rect width="100" height="100" rx="22" fill="${hex(BG)}"/>${rects}</svg>\n`;
}

const outputs = [
  { file: "icons/icon-192.png", size: 192, radius: 22, scale: 1 },
  { file: "icons/icon-512.png", size: 512, radius: 22, scale: 1 },
  // Maskable safe zone: a centered circle of 80% diameter; the glyph spans ~56% → 0.8 fits.
  { file: "icons/maskable-192.png", size: 192, radius: 0, scale: 0.8 },
  { file: "icons/maskable-512.png", size: 512, radius: 0, scale: 0.8 },
  { file: "icons/apple-touch-icon.png", size: 180, radius: 0, scale: 0.9 },
];

for (const { file, size, radius, scale } of outputs) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePng(size, render(size, { radius, scale })));
  console.log(`wrote ${file}`);
}
writeFileSync(join(root, "favicon.svg"), svg());
console.log("wrote favicon.svg");
