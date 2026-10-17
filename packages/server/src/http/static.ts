import { readFile, stat } from "node:fs/promises";
import { join, normalize, relative, sep } from "node:path";
import type { Context } from "hono";
import { getMimeType } from "hono/utils/mime";

/** Served with `no-cache`: they must be revalidated so new deploys are picked up. */
const NO_CACHE_FILES = new Set(["index.html", "sw.js", "manifest.webmanifest"]);
const IMMUTABLE = "public, max-age=31536000, immutable";

/** Cache policy for a file path relative to the dist dir (POSIX separators). */
function cacheControlFor(relPath: string): string {
  if (relPath.startsWith("assets/")) return IMMUTABLE; // content-hashed by Vite
  if (NO_CACHE_FILES.has(relPath)) return "no-cache";
  return "public, max-age=3600";
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Precompressed variants the web build writes next to its files (`web: scripts/compress-dist.ts`),
 * in order of preference.
 */
const ENCODINGS = [
  { name: "br", suffix: ".br" },
  { name: "gzip", suffix: ".gz" },
] as const;

/**
 * The precompressed variants `Accept-Encoding` allows (listed or through `*`, with a non-zero q),
 * highest q first and ties in preference order (RFC 9110, section 12.5.3).
 */
function acceptedEncodings(header: string | undefined): (typeof ENCODINGS)[number][] {
  const qualities = new Map<string, number>();
  for (const part of header?.split(",") ?? []) {
    const [token, ...params] = part.split(";").map((s) => s.trim().toLowerCase());
    if (!token || qualities.has(token)) continue;
    const q = params.find((p) => p.startsWith("q="));
    qualities.set(token, q === undefined ? 1 : Number(q.slice(2)) || 0);
  }
  const wildcard = qualities.get("*") ?? 0;
  return ENCODINGS.map((encoding) => ({ encoding, q: qualities.get(encoding.name) ?? wildcard }))
    .filter(({ q }) => q > 0)
    .sort((a, b) => b.q - a.q)
    .map(({ encoding }) => encoding);
}

/** The variant of `path` to send for `acceptEncoding`: a precompressed file, else `path` itself. */
async function variantFor(
  path: string,
  acceptEncoding: string | undefined,
): Promise<{ path: string; encoding?: string }> {
  for (const { name, suffix } of acceptedEncodings(acceptEncoding)) {
    if (await isFile(path + suffix)) return { path: path + suffix, encoding: name };
  }
  return { path };
}

/**
 * Serves the built SPA from `dir`: existing files as-is, `index.html` for any other path
 * (client-side routes), except under `/assets/` where a miss is a real 404. A file with a
 * precompressed variant the client accepts is sent as that variant.
 */
export function spaHandler(dir: string) {
  const root = normalize(dir);
  return async (c: Context) => {
    let path: string;
    try {
      path = decodeURIComponent(c.req.path);
    } catch {
      return c.text("Bad Request", 400);
    }
    if (path.includes("\0")) return c.text("Bad Request", 400);

    let rel = normalize(path).replace(/^[/\\]+/, "");
    const abs = join(root, rel);
    const inside = relative(root, abs);
    if (inside.startsWith(`..${sep}`) || inside === "..") return c.text("Not Found", 404);
    rel = inside.split(sep).join("/");

    let file = rel !== "" && (await isFile(abs)) ? rel : undefined;
    if (!file) {
      if (rel.startsWith("assets/")) return c.text("Not Found", 404);
      file = "index.html";
    }
    const variant = await variantFor(join(root, file), c.req.header("accept-encoding"));
    let body: Buffer;
    try {
      body = await readFile(variant.path);
    } catch {
      return c.text("Not Found", 404);
    }
    c.header("Content-Type", getMimeType(file) ?? "application/octet-stream");
    c.header("Cache-Control", cacheControlFor(file));
    c.header("Vary", "Accept-Encoding");
    if (variant.encoding) c.header("Content-Encoding", variant.encoding);
    if (c.req.method === "HEAD") {
      c.header("Content-Length", String(body.byteLength));
      return c.body(null, 200);
    }
    return c.body(new Uint8Array(body), 200);
  };
}
