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
 * Serves the built SPA from `dir`: existing files as-is, `index.html` for any other path
 * (client-side routes), except under `/assets/` where a miss is a real 404.
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
    let body: Buffer;
    try {
      body = await readFile(join(root, file));
    } catch {
      return c.text("Not Found", 404);
    }
    c.header("Content-Type", getMimeType(file) ?? "application/octet-stream");
    c.header("Cache-Control", cacheControlFor(file));
    if (c.req.method === "HEAD") {
      c.header("Content-Length", String(body.byteLength));
      return c.body(null, 200);
    }
    return c.body(new Uint8Array(body), 200);
  };
}
