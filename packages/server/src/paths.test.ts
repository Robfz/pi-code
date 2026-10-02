import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isApiError } from "./errors.ts";
import { canonicalPath } from "./paths.ts";

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-paths-")));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("canonicalPath", () => {
  it("resolves a missing path under a symlinked parent", async () => {
    mkdirSync(join(home, "real"));
    symlinkSync(join(home, "real"), join(home, "link"));
    expect(await canonicalPath(join(home, "link", "gone", "deeper"), home)).toBe(
      join(home, "real", "gone", "deeper"),
    );
    expect(await canonicalPath(join(home, "link"), home)).toBe(join(home, "real"));
  });

  it("confines paths to the real $HOME, through symlinks too", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-outside-")));
    try {
      symlinkSync(outside, join(home, "escape"));
      for (const path of [join(home, "escape", "x"), join(home, "..")]) {
        const e = await canonicalPath(path, home).catch((err: unknown) => err);
        expect(isApiError(e, "outside_home"), path).toBe(true);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
