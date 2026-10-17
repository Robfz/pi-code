import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compressDist } from "./compress-dist.ts";

let dist: string;

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), "pi-code-compress-"));
});

afterEach(() => {
  rmSync(dist, { recursive: true, force: true });
});

describe("compressDist", () => {
  it("writes brotli and gzip copies of text files, nested ones included", async () => {
    const js = `export const x = "${"abc".repeat(1000)}";`;
    mkdirSync(join(dist, "assets", "shiki"), { recursive: true });
    writeFileSync(join(dist, "index.html"), `<!doctype html>${"<p>pi-code</p>".repeat(100)}`);
    writeFileSync(join(dist, "assets", "shiki", "ts-abc.js"), js);

    const written = await compressDist(dist);

    const file = join(dist, "assets", "shiki", "ts-abc.js");
    expect(written.sort()).toEqual(
      [`${file}.br`, `${file}.gz`, join(dist, "index.html.br"), join(dist, "index.html.gz")].sort(),
    );
    expect(brotliDecompressSync(readFileSync(`${file}.br`)).toString()).toBe(js);
    expect(gunzipSync(readFileSync(`${file}.gz`)).toString()).toBe(js);
  });

  it("skips binary formats and copies that wouldn't be smaller", async () => {
    writeFileSync(join(dist, "icon.png"), "x".repeat(5000));
    writeFileSync(join(dist, "font.woff2"), "x".repeat(5000));
    writeFileSync(join(dist, "tiny.js"), "1");

    expect(await compressDist(dist)).toEqual([]);
    for (const name of ["icon.png", "font.woff2", "tiny.js"]) {
      expect(existsSync(join(dist, `${name}.br`))).toBe(false);
      expect(existsSync(join(dist, `${name}.gz`))).toBe(false);
    }
  });
});
