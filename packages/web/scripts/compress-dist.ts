/**
 * Writes brotli (`.br`) and gzip (`.gz`) copies of the build's text files next to them, for the
 * server to send to clients that accept them (`server: http/static.ts`). A copy that isn't
 * smaller than its file is skipped. Runs after `vite build` (`pnpm build`).
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

/** Already-compressed formats (images, woff2) gain nothing. */
const COMPRESSIBLE = /\.(?:js|mjs|css|html|svg|json|webmanifest|txt)$/;

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const ENCODERS: [suffix: string, encode: (data: Buffer) => Promise<Buffer>][] = [
  [
    ".br",
    (data) =>
      brotli(data, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength,
        },
      }),
  ],
  [".gz", (data) => gzipAsync(data, { level: constants.Z_BEST_COMPRESSION })],
];

/** Compresses every compressible file under `dir`; returns the paths written. */
export async function compressDist(dir: string): Promise<string[]> {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && COMPRESSIBLE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
  const written = await Promise.all(
    files.map(async (file) => {
      const data = await readFile(file);
      const paths: string[] = [];
      for (const [suffix, encode] of ENCODERS) {
        const compressed = await encode(data);
        if (compressed.byteLength >= data.byteLength) continue;
        await writeFile(file + suffix, compressed);
        paths.push(file + suffix);
      }
      return paths;
    }),
  );
  return written.flat();
}

if (import.meta.main) {
  await compressDist(fileURLToPath(new URL("../dist", import.meta.url)));
}
