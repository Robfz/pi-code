import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fuzzysort from "fuzzysort";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isApiError } from "../errors.ts";
import { git } from "../testing/layout-repo.ts";
import { listProjectFiles, readFileAtRev, readProjectFile, searchFiles } from "./files.ts";
import { MAX_PATCH_BYTES } from "./git.ts";

let root: string;
let repo: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-files-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes each file (creating its folders) under `repo`. */
function write(files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

function commit(): void {
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "c");
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe("listProjectFiles", () => {
  it("lists tracked and untracked files, without ignored files and nested repos", async () => {
    write({ ".gitignore": "*.log\n", "src/a.ts": "a\n", "tracked.txt": "t\n" });
    commit();
    write({ "src/new.ts": "n\n", "debug.log": "x\n", "tracked.txt": "changed\n" });
    mkdirSync(join(repo, "nested"));
    git(join(repo, "nested"), "init", "-q");
    write({ "nested/inner.txt": "i\n" });

    expect((await listProjectFiles(repo)).sort()).toEqual([
      ".gitignore",
      "src/a.ts",
      "src/new.ts",
      "tracked.txt",
    ]);
  });

  it("lists a conflicted file once", async () => {
    write({ "a.txt": "base\n", "b.txt": "b\n" });
    commit();
    git(repo, "checkout", "-q", "-b", "feature");
    write({ "a.txt": "feature\n" });
    commit();
    git(repo, "checkout", "-q", "main");
    write({ "a.txt": "main\n" });
    commit();
    expect(() => git(repo, "merge", "-q", "feature")).toThrow();
    expect(git(repo, "ls-files", "--unmerged")).toContain("a.txt");

    expect((await listProjectFiles(repo)).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("lists only the subtree of a subfolder cwd, relative to it", async () => {
    write({ "top.txt": "t\n", "pkg/src/a.ts": "a\n" });
    commit();
    write({ "pkg/b.ts": "b\n" });

    expect((await listProjectFiles(join(repo, "pkg"))).sort()).toEqual(["b.ts", "src/a.ts"]);
  });
});

describe("searchFiles", () => {
  it("ranks a basename match above a path match", async () => {
    write({ "src/agents/git-helper-test.ts": "", "src/git/git.ts": "", "README.md": "" });
    commit();

    const files = await searchFiles(repo, "git.ts");
    expect(files.indexOf("src/git/git.ts")).toBe(0);
    expect(files).toContain("src/agents/git-helper-test.ts");
    expect(files).not.toContain("README.md");
  });

  it("ranks a weak basename match above a strong cross-directory one", async () => {
    write({ "g/t/readme.md": "", "docs/big-elephant.ts": "" });
    // Scored on paths alone, the cross-directory match is the stronger one.
    expect(fuzzysort.single("gt", "g/t/readme.md")?.score).toBeGreaterThan(
      fuzzysort.single("gt", "docs/big-elephant.ts")?.score ?? 1,
    );

    expect(await searchFiles(repo, "gt")).toEqual(["docs/big-elephant.ts", "g/t/readme.md"]);
  });

  it("hands fuzzysort prepared targets, which it doesn't cache", async () => {
    write({ "src/a.ts": "" });
    const go = vi.spyOn(fuzzysort, "go");
    try {
      expect(await searchFiles(repo, "a")).toEqual(["src/a.ts"]);
      // `go` keeps the strings it prepares itself in a module-level cache that never shrinks.
      const targets = go.mock.calls[0]?.[1] as unknown as object[];
      expect(targets.flatMap(Object.values).every((t) => typeof t === "object")).toBe(true);
    } finally {
      go.mockRestore();
    }
  });

  it("returns at most 10 files", async () => {
    write(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`file${i}.ts`, ""])));
    expect(await searchFiles(repo, "file")).toHaveLength(10);
  });

  it("returns nothing for an empty query and rejects one over 200 characters", async () => {
    write({ "a.ts": "" });
    expect(await searchFiles(repo, "  ")).toEqual([]);
    expect(await searchFiles(repo, ` ${"a".repeat(200)} `)).toEqual([]);
    expect(isApiError(await rejection(searchFiles(repo, "a".repeat(201))), "invalid_body")).toBe(
      true,
    );
  });

  it("rejects a folder outside a work tree", async () => {
    const folder = join(root, "plain");
    mkdirSync(folder);
    expect(isApiError(await rejection(searchFiles(folder, "a")), "not_a_git_repo")).toBe(true);
  });
});

describe("readProjectFile", () => {
  it("reads a text file as UTF-8, by relative or absolute path", async () => {
    write({ "src/a.ts": "héllo\n" });
    const expected = { path: "src/a.ts", content: "héllo\n", binary: false, tooLarge: false };
    expect(await readProjectFile(repo, "src/a.ts")).toEqual(expected);
    expect(await readProjectFile(repo, "./src/../src/a.ts")).toEqual(expected);
    expect(await readProjectFile(repo, join(repo, "src/a.ts"))).toEqual(expected);
  });

  it("reads paths relative to a subfolder cwd", async () => {
    write({ "pkg/a.ts": "a\n" });
    expect(await readProjectFile(join(repo, "pkg"), join(repo, "pkg/a.ts"))).toMatchObject({
      path: "a.ts",
      content: "a\n",
    });
  });

  it("reads an empty file", async () => {
    write({ "empty.txt": "" });
    expect(await readProjectFile(repo, "empty.txt")).toEqual({
      path: "empty.txt",
      content: "",
      binary: false,
      tooLarge: false,
    });
  });

  it("flags binary and too-large files without content", async () => {
    write({
      "image.bin": Buffer.concat([Buffer.alloc(7000, "a"), Buffer.from([0])]),
      "late-nul.txt": Buffer.concat([Buffer.alloc(8000, "a"), Buffer.from([0])]),
      "big.txt": "x".repeat(MAX_PATCH_BYTES + 1),
    });
    expect(await readProjectFile(repo, "image.bin")).toEqual({
      path: "image.bin",
      binary: true,
      tooLarge: false,
    });
    expect((await readProjectFile(repo, "late-nul.txt")).binary).toBe(false);
    expect(await readProjectFile(repo, "big.txt")).toEqual({
      path: "big.txt",
      binary: false,
      tooLarge: true,
    });
  });

  it("answers file_not_found for a missing file, a directory and the cwd", async () => {
    write({ "src/a.ts": "" });
    for (const path of ["missing.ts", "src", ".", "src/a.ts/x"]) {
      expect(isApiError(await rejection(readProjectFile(repo, path)), "file_not_found")).toBe(true);
    }
  });

  it("rejects paths leading out of the cwd", async () => {
    writeFileSync(join(root, "x"), "secret\n");
    write({ "pkg/a.ts": "" });
    symlinkSync(join(root, "x"), join(repo, "link"));
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "out", "y"), "secret\n");
    symlinkSync(join(root, "out"), join(repo, "out-link"));
    const cases: [string, string][] = [
      [repo, "../x"],
      [repo, "../missing"],
      [repo, join(root, "x")],
      [repo, "link"],
      [join(repo, "pkg"), "../link"],
      [repo, "out-link/y"],
      [repo, "out-link/missing"],
    ];
    for (const [cwd, path] of cases) {
      const error = await rejection(readProjectFile(cwd, path));
      expect(isApiError(error, "invalid_body")).toBe(true);
      expect((error as Error).message).toBe(`${path} is outside the project`);
    }
  });

  it("resolves absolute paths through a symlinked cwd", async () => {
    write({ "a.ts": "a\n" });
    const cwd = join(root, "repo-link");
    symlinkSync(repo, cwd);
    expect(await readProjectFile(cwd, join(cwd, "a.ts"))).toMatchObject({ path: "a.ts" });
    const missing = join(cwd, "missing.ts");
    expect(isApiError(await rejection(readProjectFile(cwd, missing)), "file_not_found")).toBe(true);
  });

  it("follows a symlink inside the cwd", async () => {
    write({ "real.txt": "r\n" });
    symlinkSync("real.txt", join(repo, "alias.txt"));
    expect(await readProjectFile(repo, "alias.txt")).toMatchObject({
      path: "real.txt",
      content: "r\n",
    });
  });

  it("rejects a folder outside a work tree", async () => {
    const folder = join(root, "plain");
    mkdirSync(folder);
    writeFileSync(join(folder, "a.txt"), "a\n");
    expect(isApiError(await rejection(readProjectFile(folder, "a.txt")), "not_a_git_repo")).toBe(
      true,
    );
  });
});

describe("readFileAtRev", () => {
  it("reads a file as committed, whatever the working tree holds", async () => {
    write({ "pkg/a.ts": "old\n", "pkg/keep.ts": "" });
    commit();
    const rev = git(repo, "rev-parse", "--short=7", "HEAD").trim();
    write({ "pkg/a.ts": "new\n" });
    commit();
    git(repo, "rm", "-q", "pkg/a.ts");
    const expected = { path: "pkg/a.ts", rev, content: "old\n", binary: false, tooLarge: false };
    expect(await readFileAtRev(repo, "pkg/a.ts", rev)).toEqual(expected);
    expect(await readFileAtRev(repo, join(repo, "pkg/a.ts"), rev)).toEqual(expected);
    // From a subfolder cwd, paths are relative to it.
    expect(await readFileAtRev(join(repo, "pkg"), "a.ts", rev)).toMatchObject({
      path: "a.ts",
      content: "old\n",
    });
  });

  it("flags binary and too-large blobs without content", async () => {
    write({
      "image.bin": Buffer.concat([Buffer.alloc(10, "a"), Buffer.from([0])]),
      "big.txt": "x".repeat(MAX_PATCH_BYTES + 1),
    });
    commit();
    const rev = git(repo, "rev-parse", "HEAD").trim();
    expect(await readFileAtRev(repo, "image.bin", rev)).toMatchObject({ binary: true });
    expect(await readFileAtRev(repo, "big.txt", rev)).toMatchObject({ tooLarge: true });
  });

  it("validates the rev and the path", async () => {
    write({ "a.ts": "a\n", "src/b.ts": "" });
    commit();
    const rev = git(repo, "rev-parse", "HEAD").trim();
    for (const bad of ["HEAD", "main", "abc", "-1234567", `${rev}x`]) {
      expect(isApiError(await rejection(readFileAtRev(repo, "a.ts", bad)), "invalid_body")).toBe(
        true,
      );
    }
    for (const path of ["../x", join(root, "x")]) {
      expect(isApiError(await rejection(readFileAtRev(repo, path, rev)), "invalid_body")).toBe(
        true,
      );
    }
    for (const [path, at] of [
      ["missing.ts", rev],
      ["src", rev],
      [".", rev],
      ["a.ts", "0".repeat(40)],
    ] as const) {
      expect(isApiError(await rejection(readFileAtRev(repo, path, at)), "file_not_found")).toBe(
        true,
      );
    }
  });
});
