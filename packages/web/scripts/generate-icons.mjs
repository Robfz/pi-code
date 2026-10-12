#!/usr/bin/env node
/**
 * Generates the PWA icons in `public/` with Node built-ins only (zlib for PNG compression):
 * a "π" whose right leg hooks into a prompt underscore that fades out, on a dark square.
 *
 *   node scripts/generate-icons.mjs
 *
 * - `icons/icon-{192,512}.png`: rounded square with a hairline edge, transparent corners
 *   (purpose "any").
 * - `icons/maskable-{192,512}.png`: full-bleed background, glyph inside the safe zone.
 * - `icons/apple-touch-icon.png` (180): full bleed; iOS rounds it.
 * - `favicon.svg`: the same drawing as vector.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// Dark-theme tokens from docs/design/09-ui-overhaul.md: --card, --foreground, --faint-foreground.
const BG = [0x13, 0x13, 0x13];
const FG = [0xe8, 0xe8, 0xe8];
const FADE = [0x63, 0x63, 0x63];
// The --border hairline (white at 12%) composited over BG; keeps the tile visible on dark surfaces.
const EDGE = [0x2f, 0x2f, 0x2f];

const RADIUS = 22; // background corner radius
const EDGE_WIDTH = 1;

/**
 * Glyph in a 100×100 design space: strokes 9 wide with butt caps. A bar, a straight left leg,
 * and a right leg that turns through a quarter circle (radius 8, centre 60,61.5) into a foot
 * running on as the prompt underscore.
 */
const STROKE = 9;
const HOOK = { cx: 60, cy: 61.5, r: 8 };
const RECTS = [
  { x: 18, y: 28.5, w: 48, h: STROKE }, // bar
  { x: 25.5, y: 33, w: STROKE, h: 41 }, // left leg
  { x: 47.5, y: 33, w: STROKE, h: HOOK.cy - 33 }, // right leg
  { x: HOOK.cx, y: 65, w: 24, h: STROKE }, // foot / underscore
];
// The underscore fades from FG to FADE over this x range; the rest of the glyph sits left of it.
const FADE_FROM = 66.4;
const FADE_TO = 84;

function inGlyph(x, y) {
  for (const r of RECTS) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
  if (x > HOOK.cx || y < HOOK.cy) return false;
  const d = Math.hypot(x - HOOK.cx, y - HOOK.cy);
  return d >= HOOK.r - STROKE / 2 && d <= HOOK.r + STROKE / 2;
}

function glyphColor(x) {
  const t = Math.min(Math.max((x - FADE_FROM) / (FADE_TO - FADE_FROM), 0), 1);
  return FG.map((c, i) => c + (FADE[i] - c) * t);
}

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
 * @param opts.rounded  rounded tile with a hairline edge (false = full-bleed square)
 * @param opts.scale    glyph scale around the center (maskable icons shrink into the safe zone)
 */
function render(size, { rounded, scale }) {
  const SS = 4;
  const rgba = new Uint8Array(size * size * 4);
  const unit = 100 / size;
  const inner = 100 - 2 * EDGE_WIDTH;

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
          if (rounded && !inRoundedRect(x, y, 0, 0, 100, 100, RADIUS)) continue;
          // Sample the glyph in its unscaled design space.
          const gx = 50 + (x - 50) / scale;
          const gy = 50 + (y - 50) / scale;
          let color = BG;
          if (inGlyph(gx, gy)) color = glyphColor(gx);
          else if (
            rounded &&
            !inRoundedRect(x, y, EDGE_WIDTH, EDGE_WIDTH, inner, inner, RADIUS - EDGE_WIDTH)
          )
            color = EDGE;
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
  const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  const half = EDGE_WIDTH / 2;
  const [bar, left, right, foot] = RECTS;
  const mid = (r) => r.y + r.h / 2;
  const glyph =
    `<path d="M${bar.x} ${mid(bar)}H${bar.x + bar.w}M${left.x + STROKE / 2} ${left.y}V${left.y + left.h}"/>` +
    `<path d="M${right.x + STROKE / 2} ${right.y}V${HOOK.cy}A${HOOK.r} ${HOOK.r} 0 0 0 ${HOOK.cx} ${mid(foot)}H${foot.x + foot.w}" stroke="url(#fade)"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>pi-code</title>` +
    `<defs><linearGradient id="fade" gradientUnits="userSpaceOnUse" x1="${FADE_FROM}" y1="0" x2="${FADE_TO}" y2="0">` +
    `<stop offset="0" stop-color="${hex(FG)}"/><stop offset="1" stop-color="${hex(FADE)}"/></linearGradient></defs>` +
    `<rect x="${half}" y="${half}" width="${100 - EDGE_WIDTH}" height="${100 - EDGE_WIDTH}" rx="${RADIUS - half}" fill="${hex(BG)}" stroke="${hex(EDGE)}" stroke-width="${EDGE_WIDTH}"/>` +
    `<g fill="none" stroke="${hex(FG)}" stroke-width="${STROKE}">${glyph}</g></svg>\n`
  );
}

const outputs = [
  { file: "icons/icon-192.png", size: 192, rounded: true, scale: 1 },
  { file: "icons/icon-512.png", size: 512, rounded: true, scale: 1 },
  // Maskable safe zone: a centered circle of 80% diameter. The glyph's farthest corner is ~42
  // units from the center, so 0.8 keeps it inside.
  { file: "icons/maskable-192.png", size: 192, rounded: false, scale: 0.8 },
  { file: "icons/maskable-512.png", size: 512, rounded: false, scale: 0.8 },
  { file: "icons/apple-touch-icon.png", size: 180, rounded: false, scale: 0.9 },
];

for (const { file, size, rounded, scale } of outputs) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePng(size, render(size, { rounded, scale })));
  console.log(`wrote ${file}`);
}
writeFileSync(join(root, "favicon.svg"), svg());
console.log("wrote favicon.svg");
