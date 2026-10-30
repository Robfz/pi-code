/**
 * Draws the PWA icons with Node built-ins only (zlib for PNG compression): a "π" whose right leg
 * hooks into a prompt underscore that fades out, on a square tile. The `appIcons` plugin in
 * `vite.config.ts` serves them in dev and writes them into the build.
 *
 * - `icons/icon-{192,512}.png`: rounded square with a hairline edge, transparent corners
 *   (purpose "any").
 * - `icons/maskable-{192,512}.png`: full-bleed background, glyph inside the safe zone.
 * - `icons/apple-touch-icon.png` (180): full bleed; iOS rounds it.
 * - `favicon.svg`: the same drawing as vector.
 */

import { deflateSync } from "node:zlib";

type Rgb = readonly [number, number, number];

interface Colors {
  bg: Rgb;
  fg: Rgb;
  fade: Rgb;
  /** The --border hairline composited over `bg`; keeps the tile visible on same-tone surfaces. */
  edge: Rgb;
}

/** Tokens from `src/index.css` for each theme: --card, --foreground, --faint-foreground, --border. */
const VARIANTS = {
  dark: {
    bg: [0x13, 0x13, 0x13],
    fg: [0xe8, 0xe8, 0xe8],
    fade: [0x63, 0x63, 0x63],
    edge: [0x2f, 0x2f, 0x2f],
  },
  light: {
    bg: [0xf6, 0xf6, 0xf6],
    fg: [0x18, 0x18, 0x18],
    fade: [0x89, 0x89, 0x89],
    edge: [0xe0, 0xe0, 0xe0],
  },
} satisfies Record<string, Colors>;

export type IconVariant = keyof typeof VARIANTS;

export function isIconVariant(value: string): value is IconVariant {
  return Object.hasOwn(VARIANTS, value);
}

export const ICON_VARIANTS = Object.keys(VARIANTS) as IconVariant[];

const RADIUS = 22; // background corner radius
const EDGE_WIDTH = 1;

/**
 * Glyph in a 100×100 design space: strokes 9 wide with butt caps. A bar, a straight left leg,
 * and a right leg that turns through a quarter circle (radius 8, centre 60,61.5) into a foot
 * running on as the prompt underscore.
 */
const STROKE = 9;
const HOOK = { cx: 60, cy: 61.5, r: 8 };
const [BAR, LEFT, RIGHT, FOOT] = [
  { x: 18, y: 28.5, w: 48, h: STROKE },
  { x: 25.5, y: 33, w: STROKE, h: 41 },
  { x: 47.5, y: 33, w: STROKE, h: HOOK.cy - 33 },
  { x: HOOK.cx, y: 65, w: 24, h: STROKE },
];
const RECTS = [BAR, LEFT, RIGHT, FOOT];
// The underscore fades from fg to fade over this x range; the rest of the glyph sits left of it.
const FADE_FROM = 66.4;
const FADE_TO = 84;

function inGlyph(x: number, y: number): boolean {
  for (const r of RECTS) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
  if (x > HOOK.cx || y < HOOK.cy) return false;
  const d = Math.hypot(x - HOOK.cx, y - HOOK.cy);
  return d >= HOOK.r - STROKE / 2 && d <= HOOK.r + STROKE / 2;
}

function glyphColor(x: number, { fg, fade }: Colors): Rgb {
  const t = Math.min(Math.max((x - FADE_FROM) / (FADE_TO - FADE_FROM), 0), 1);
  const channel = (i: 0 | 1 | 2) => fg[i] + (fade[i] - fg[i]) * t;
  return [channel(0), channel(1), channel(2)];
}

// ---------------------------------------------------------------------------
// Rasterizer: 4×4 supersampling over shape tests.

/** Inside a rounded rectangle? */
function inRoundedRect(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): boolean {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/**
 * @param size   output pixels
 * @param rounded  rounded tile with a hairline edge (false = full-bleed square)
 * @param scale    glyph scale around the center (maskable icons shrink into the safe zone)
 */
function render(
  size: number,
  { rounded, scale }: { rounded: boolean; scale: number },
  colors: Colors,
): Uint8Array {
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
          let color = colors.bg;
          if (inGlyph(gx, gy)) color = glyphColor(gx, colors);
          else if (
            rounded &&
            !inRoundedRect(x, y, EDGE_WIDTH, EDGE_WIDTH, inner, inner, RADIUS - EDGE_WIDTH)
          )
            color = colors.edge;
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

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size: number, rgba: Uint8Array): Buffer {
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

function svg({ bg, fg, fade, edge }: Colors): string {
  const hex = (c: Rgb) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  const half = EDGE_WIDTH / 2;
  const mid = (r: { y: number; h: number }) => r.y + r.h / 2;
  const glyph =
    `<path d="M${BAR.x} ${mid(BAR)}H${BAR.x + BAR.w}M${LEFT.x + STROKE / 2} ${LEFT.y}V${LEFT.y + LEFT.h}"/>` +
    `<path d="M${RIGHT.x + STROKE / 2} ${RIGHT.y}V${HOOK.cy}A${HOOK.r} ${HOOK.r} 0 0 0 ${HOOK.cx} ${mid(FOOT)}H${FOOT.x + FOOT.w}" stroke="url(#fade)"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>pi-code</title>` +
    `<defs><linearGradient id="fade" gradientUnits="userSpaceOnUse" x1="${FADE_FROM}" y1="0" x2="${FADE_TO}" y2="0">` +
    `<stop offset="0" stop-color="${hex(fg)}"/><stop offset="1" stop-color="${hex(fade)}"/></linearGradient></defs>` +
    `<rect x="${half}" y="${half}" width="${100 - EDGE_WIDTH}" height="${100 - EDGE_WIDTH}" rx="${RADIUS - half}" fill="${hex(bg)}" stroke="${hex(edge)}" stroke-width="${EDGE_WIDTH}"/>` +
    `<g fill="none" stroke="${hex(fg)}" stroke-width="${STROKE}">${glyph}</g></svg>\n`
  );
}

const PNGS = [
  { fileName: "icons/icon-192.png", size: 192, rounded: true, scale: 1 },
  { fileName: "icons/icon-512.png", size: 512, rounded: true, scale: 1 },
  // Maskable safe zone: a centered circle of 80% diameter. The glyph's farthest corner is ~42
  // units from the center, so 0.8 keeps it inside.
  { fileName: "icons/maskable-192.png", size: 192, rounded: false, scale: 0.8 },
  { fileName: "icons/maskable-512.png", size: 512, rounded: false, scale: 0.8 },
  { fileName: "icons/apple-touch-icon.png", size: 180, rounded: false, scale: 0.9 },
];

/** Every icon file of a variant, keyed by its path in the build (no leading slash). */
export function renderAppIcons(variant: IconVariant): Map<string, Uint8Array | string> {
  const colors = VARIANTS[variant];
  const files = new Map<string, Uint8Array | string>();
  for (const { fileName, size, rounded, scale } of PNGS) {
    files.set(fileName, encodePng(size, render(size, { rounded, scale }, colors)));
  }
  files.set("favicon.svg", svg(colors));
  return files;
}
