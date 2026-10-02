import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteSessionFiles } from "./session-files.ts";

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pi-code-session-files-"));
  file = join(tmp, "session.jsonl");
  writeFileSync(file, "{}\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** An executable shell script at `<tmp>/<name>`. */
function script(name: string, body: string): string {
  const path = join(tmp, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

describe("deleteSessionFiles", () => {
  it("hands the file to the trash command, without a shell", async () => {
    const log = join(tmp, "args.txt");
    const trash = script("trash", `printf '%s' "$1" > '${log}'; rm -- "$1"`);
    const odd = join(tmp, "a b;$(x).jsonl");
    writeFileSync(odd, "{}\n");
    expect(await deleteSessionFiles([odd], trash)).toEqual([]);
    expect(readFileSync(log, "utf8")).toBe(odd);
    expect(existsSync(odd)).toBe(false);
  });

  it("counts an exit 0 that leaves the file as done", async () => {
    expect(await deleteSessionFiles([file], "true")).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });

  it("counts a failing trash that moved the file as done", async () => {
    expect(await deleteSessionFiles([file], script("trash", 'rm -- "$1"; exit 1'))).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it("unlinks when trash fails, is missing or hangs", async () => {
    expect(await deleteSessionFiles([file], "false")).toEqual([]);
    expect(existsSync(file)).toBe(false);

    writeFileSync(file, "{}\n");
    expect(await deleteSessionFiles([file], join(tmp, "no-such-trash"))).toEqual([]);
    expect(existsSync(file)).toBe(false);

    writeFileSync(file, "{}\n");
    const started = Date.now();
    expect(await deleteSessionFiles([file], script("trash", "exec sleep 30"), 200)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(file)).toBe(false);
  });

  it("skips trash for the remaining files after it times out once", async () => {
    const files = ["a", "b", "c"].map((name) => join(tmp, `${name}.jsonl`));
    for (const f of files) writeFileSync(f, "{}\n");
    const started = Date.now();
    expect(await deleteSessionFiles(files, script("trash", "exec sleep 30"), 1_000)).toEqual([]);
    // Waiting out every file's timeout would take 3 s.
    expect(Date.now() - started).toBeLessThan(2_500);
    for (const f of files) expect(existsSync(f), f).toBe(false);
  });

  it("returns the files it can't delete, after deleting the others", async () => {
    const dir = join(tmp, "locked");
    mkdirSync(dir);
    const locked = join(dir, "s.jsonl");
    writeFileSync(locked, "{}\n");
    chmodSync(dir, 0o555);
    try {
      expect(await deleteSessionFiles([locked, file], "false")).toEqual([locked]);
      expect(existsSync(locked)).toBe(true);
      expect(existsSync(file)).toBe(false);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});
