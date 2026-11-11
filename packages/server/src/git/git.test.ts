import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitFileDiff } from "@pi-code/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isApiError } from "../errors.ts";
import { FILE_DIFF_CONCURRENCY, gitDiff, gitStatus, MAX_PATCH_BYTES } from "./git.ts";

// Spied on to count the git processes a diff spawns.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

let root: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function commit(message = "c"): void {
  git("add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", message);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-git-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const byPath = (files: GitFileDiff[]) => Object.fromEntries(files.map((f) => [f.path, f]));
const paths = (files: GitFileDiff[]) => files.map((f) => f.path).sort();
const shortSha = (rev: string) => git("rev-parse", "--short", rev).trim();

/** `gitDiff`'s rejection, or `undefined` when it resolves. */
async function diffError(...args: Parameters<typeof gitDiff>): Promise<unknown> {
  try {
    await gitDiff(...args);
  } catch (e) {
    return e;
  }
  return undefined;
}

/** Commits `count` files `<i>.txt`, then turns each into a symlink: a type change per file. */
function typeChanges(count: number): void {
  writeFileSync(join(repo, "t.txt"), "target\n");
  for (let i = 0; i < count; i++) writeFileSync(join(repo, `${i}.txt`), `${i}\n`);
  commit();
  for (let i = 0; i < count; i++) {
    unlinkSync(join(repo, `${i}.txt`));
    execFileSync("ln", ["-s", "t.txt", `${i}.txt`], { cwd: repo });
  }
}

describe("gitDiff", () => {
  it("covers modified, added, deleted, renamed, untracked and binary files", async () => {
    writeFileSync(join(repo, "modified.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "deleted.txt"), "bye\n");
    writeFileSync(join(repo, "old name.txt"), "a stable file\nwith enough\nlines to be\nrenamed\n");
    writeFileSync(join(repo, "image.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
    commit();
    const head = shortSha("HEAD");

    writeFileSync(join(repo, "modified.txt"), "one\n2\n");
    unlinkSync(join(repo, "deleted.txt"));
    git("mv", "old name.txt", "new name.txt");
    writeFileSync(join(repo, "added.txt"), "staged\n");
    git("add", "added.txt");
    writeFileSync(join(repo, "image.bin"), Buffer.from([0, 9, 9, 9, 0, 255]));
    mkdirSync(join(repo, "dir"));
    writeFileSync(join(repo, "dir", "untracked.txt"), "new\nfile\n");
    writeFileSync(join(repo, "untracked.bin"), Buffer.from([0, 0, 1]));
    writeFileSync(join(repo, "ignored.log"), "x\n");

    const diff = await gitDiff(repo);
    expect(diff.oldRev).toBe(head);
    expect(diff.newRev).toBeUndefined();
    const files = byPath(diff.files);
    expect(Object.keys(files).sort()).toEqual([
      "added.txt",
      "deleted.txt",
      "dir/untracked.txt",
      "image.bin",
      "modified.txt",
      "new name.txt",
      "untracked.bin",
    ]);
    expect(files["modified.txt"]).toMatchObject({
      status: "modified",
      binary: false,
      tooLarge: false,
    });
    expect(files["modified.txt"]?.patch).toMatch(/^diff --git a\/modified.txt b\/modified.txt\n/);
    expect(files["modified.txt"]?.patch).toContain("-two\n+2\n");
    expect(files["added.txt"]).toMatchObject({ status: "added" });
    expect(files["added.txt"]?.patch).toContain("+staged");
    expect(files["deleted.txt"]).toMatchObject({ status: "deleted" });
    expect(files["deleted.txt"]?.patch).toContain("-bye");
    expect(files["new name.txt"]).toMatchObject({ status: "renamed", oldPath: "old name.txt" });
    expect(files["new name.txt"]?.patch).toContain("rename from old name.txt");
    expect(files["image.bin"]).toMatchObject({ status: "modified", binary: true });
    expect(files["image.bin"]?.patch).toBeUndefined();
    expect(files["dir/untracked.txt"]).toMatchObject({ status: "untracked", binary: false });
    expect(files["dir/untracked.txt"]?.patch).toContain("new file mode");
    expect(files["dir/untracked.txt"]?.patch).toContain("+++ b/dir/untracked.txt");
    expect(files["dir/untracked.txt"]?.patch).toContain("+new\n+file\n");
    expect(files["untracked.bin"]).toMatchObject({ status: "untracked", binary: true });
    expect(files["untracked.bin"]?.patch).toBeUndefined();
  });

  it("lists files over 1 MB without a patch", async () => {
    writeFileSync(join(repo, "small.txt"), "a\n");
    writeFileSync(join(repo, "big.txt"), "x\n");
    writeFileSync(join(repo, "gone.txt"), `${"g".repeat(80)}\n`.repeat(15_000));
    commit();
    const big = `${"y".repeat(99)}\n`.repeat(Math.ceil(MAX_PATCH_BYTES / 100) + 10);
    writeFileSync(join(repo, "big.txt"), big);
    writeFileSync(join(repo, "big-untracked.txt"), big);
    writeFileSync(join(repo, "small.txt"), "b\n");
    unlinkSync(join(repo, "gone.txt"));

    const files = byPath((await gitDiff(repo)).files);
    expect(files["big.txt"]).toMatchObject({ status: "modified", tooLarge: true, binary: false });
    expect(files["big.txt"]?.patch).toBeUndefined();
    expect(files["gone.txt"]).toMatchObject({ status: "deleted", tooLarge: true });
    expect(files["big-untracked.txt"]).toMatchObject({ status: "untracked", tooLarge: true });
    expect(files["small.txt"]?.patch).toContain("+b");
  });

  it("diffs a repository without commits against the empty tree", async () => {
    writeFileSync(join(repo, "staged.txt"), "s\n");
    git("add", "staged.txt");
    writeFileSync(join(repo, "loose.txt"), "l\n");
    const diff = await gitDiff(repo);
    expect(diff.oldRev).toBeUndefined();
    const files = byPath(diff.files);
    expect(files["staged.txt"]).toMatchObject({ status: "added" });
    expect(files["staged.txt"]?.patch).toContain("+s");
    expect(files["loose.txt"]).toMatchObject({ status: "untracked" });
    expect(await gitStatus(repo)).toEqual({ branch: "main", dirty: true });
  });

  it("is empty for a clean repo", async () => {
    writeFileSync(join(repo, "top.txt"), "t\n");
    commit();
    expect(await gitDiff(repo)).toEqual({ files: [], oldRev: shortSha("HEAD") });
  });

  it("scopes a subfolder cwd to its subtree with cwd-relative paths", async () => {
    mkdirSync(join(repo, "sub", "deep"), { recursive: true });
    writeFileSync(join(repo, "sub", "f.txt"), "f\n");
    writeFileSync(join(repo, "sub", "gone.txt"), "g\n");
    writeFileSync(join(repo, "top.txt"), "t\n");
    commit();
    writeFileSync(join(repo, "top.txt"), "changed\n");
    writeFileSync(join(repo, "top-untracked.txt"), "u\n");
    writeFileSync(join(repo, "sub", "f.txt"), "f2\n");
    writeFileSync(join(repo, "sub", "deep", "new.txt"), "n\n");
    unlinkSync(join(repo, "sub", "gone.txt"));

    const diff = await gitDiff(join(repo, "sub"));
    expect(paths(diff.files)).toEqual(["deep/new.txt", "f.txt", "gone.txt"]);
    const files = byPath(diff.files);
    expect(files["f.txt"]?.patch).toMatch(/^diff --git a\/f.txt b\/f.txt\n/);
    expect(files["gone.txt"]).toMatchObject({ status: "deleted" });
    expect(files["deep/new.txt"]).toMatchObject({ status: "untracked" });
    expect(files["deep/new.txt"]?.patch).toContain("+++ b/deep/new.txt");
  });

  it("falls back to per-file diffs when a type changes", async () => {
    writeFileSync(join(repo, "t.txt"), "target\n");
    writeFileSync(join(repo, "link"), "plain\n");
    commit();
    unlinkSync(join(repo, "link"));
    execFileSync("ln", ["-s", "t.txt", "link"], { cwd: repo });
    writeFileSync(join(repo, "t.txt"), "target 2\n");
    const files = byPath((await gitDiff(repo)).files);
    expect(files.link).toMatchObject({ status: "modified" });
    expect(files.link?.patch).toContain("+t.txt");
    expect(files["t.txt"]?.patch).toContain("+target 2");
  });

  it("diffs every file in the per-file fallback", async () => {
    const count = 30;
    typeChanges(count);
    const files = byPath((await gitDiff(repo)).files);
    expect(Object.keys(files)).toHaveLength(count);
    for (let i = 0; i < count; i++) {
      expect(files[`${i}.txt`]).toMatchObject({ status: "modified" });
      expect(files[`${i}.txt`]?.patch).toContain(`-${i}\n`);
      expect(files[`${i}.txt`]?.patch).toContain("+t.txt");
    }
  });

  it("runs the per-file fallback at most FILE_DIFF_CONCURRENCY at a time", async () => {
    typeChanges(30);
    const real = vi.mocked(spawn).getMockImplementation() as typeof spawn;
    let running = 0;
    let peak = 0;
    vi.mocked(spawn).mockImplementation(((command: string, args: string[], options: object) => {
      const child = real(command, args, options);
      // Only the fallback passes `--literal-pathspecs`.
      if (args.includes("--literal-pathspecs")) {
        peak = Math.max(peak, ++running);
        child.on("close", () => running--);
      }
      return child;
    }) as typeof spawn);
    try {
      expect((await gitDiff(repo)).files).toHaveLength(30);
    } finally {
      vi.mocked(spawn).mockImplementation(real);
    }
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(FILE_DIFF_CONCURRENCY);
  });

  it("rejects a directory outside any work tree", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(isApiError(await diffError(plain), "not_a_git_repo")).toBe(true);
    expect(await gitStatus(plain)).toBeNull();
  });
});

describe("gitDiff in branch mode", () => {
  /** `main` with two commits, then `feature` with one commit on top. */
  function featureBranch(): void {
    writeFileSync(join(repo, "base.txt"), "base\n");
    writeFileSync(join(repo, "edited.txt"), "one\n");
    commit("main 1");
    writeFileSync(join(repo, "main-only.txt"), "m\n");
    commit("main 2");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(repo, "edited.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "feature.txt"), "f\n");
    commit("feature 1");
    // main moves on; the merge-base stays at "main 2".
    git("checkout", "-q", "main");
    writeFileSync(join(repo, "later.txt"), "l\n");
    commit("main 3");
    git("checkout", "-q", "feature");
  }

  it("diffs the merge-base against HEAD and flags files changed in the working tree", async () => {
    featureBranch();
    const mergeBase = shortSha("main~1");
    writeFileSync(join(repo, "edited.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(repo, "base.txt"), "uncommitted\n");
    writeFileSync(join(repo, "untracked.txt"), "u\n");

    const diff = await gitDiff(repo, { base: "main" });
    expect(diff.oldRev).toBe(mergeBase);
    expect(diff.newRev).toBe(shortSha("HEAD"));
    expect(paths(diff.files)).toEqual(["edited.txt", "feature.txt"]);
    const files = byPath(diff.files);
    expect(files["edited.txt"]).toMatchObject({ status: "modified", worktreeChanged: true });
    expect(files["edited.txt"]?.patch).toContain(" one\n+two\n");
    expect(files["edited.txt"]?.patch).not.toContain("three");
    expect(files["feature.txt"]).toMatchObject({ status: "added" });
    expect(files["feature.txt"]?.worktreeChanged).toBeUndefined();
  });

  it("includes uncommitted and untracked changes against the merge-base", async () => {
    featureBranch();
    writeFileSync(join(repo, "edited.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(repo, "base.txt"), "uncommitted\n");
    writeFileSync(join(repo, "untracked.txt"), "u\n");

    const diff = await gitDiff(repo, { base: "main", uncommitted: true });
    expect(diff.oldRev).toBe(shortSha("main~1"));
    expect(diff.newRev).toBeUndefined();
    expect(paths(diff.files)).toEqual(["base.txt", "edited.txt", "feature.txt", "untracked.txt"]);
    const files = byPath(diff.files);
    expect(files["edited.txt"]?.patch).toContain(" one\n+two\n+three\n");
    expect(files["edited.txt"]?.worktreeChanged).toBeUndefined();
    expect(files["untracked.txt"]).toMatchObject({ status: "untracked" });
  });

  it("follows the repository's diff config in every mode but PR mode", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const changed = (...at: number[]) =>
      `${lines.map((l, i) => (at.includes(i) ? `${l}!` : l)).join("\n")}\n`;
    writeFileSync(join(repo, "a.txt"), changed());
    commit("main");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(repo, "a.txt"), changed(10));
    commit("feature");
    writeFileSync(join(repo, "a.txt"), changed(5, 10));
    git("config", "diff.context", "0");

    const contextLines = async (options: Parameters<typeof gitDiff>[1]) =>
      (await gitDiff(repo, options)).files[0]?.patch?.split("\n").filter((l) => l.startsWith(" "));
    expect(await contextLines({})).toEqual([]);
    expect(await contextLines({ base: "main" })).toEqual([]);
    expect(await contextLines({ base: "main", uncommitted: true })).toEqual([]);
    const range = { from: git("rev-parse", "main").trim(), to: git("rev-parse", "HEAD").trim() };
    expect(await contextLines({ range })).toHaveLength(6);
  });

  it("abbreviates revisions to at least 7 digits whatever core.abbrev says", async () => {
    featureBranch();
    git("config", "core.abbrev", "4");
    const diff = await gitDiff(repo, { base: "main" });
    expect(diff.oldRev).toBe(git("rev-parse", "--short=7", "main~1").trim());
    expect(diff.newRev).toBe(git("rev-parse", "--short=7", "HEAD").trim());
    expect(diff.newRev).toMatch(/^[0-9a-f]{7,40}$/);
  });

  /** `featureBranch`, with local `main` reset to "main 1", behind the merge-base. */
  function staleMain(): { mergeBase: string; tip: string } {
    featureBranch();
    const refs = {
      mergeBase: git("rev-parse", "main~1").trim(),
      tip: git("rev-parse", "main").trim(),
    };
    git("branch", "-f", "main", "main~2");
    return refs;
  }

  it("prefers origin/<base> over the local branch", async () => {
    const { mergeBase, tip } = staleMain();
    git("update-ref", "refs/remotes/origin/main", tip);
    const diff = await gitDiff(repo, { base: "main" });
    expect(diff.oldRev).toBe(shortSha(mergeBase));
    expect(paths(diff.files)).toEqual(["edited.txt", "feature.txt"]);
  });

  it("falls back to the local branch without origin/<base>", async () => {
    staleMain();
    git("update-ref", "refs/remotes/origin/other", "HEAD");
    const diff = await gitDiff(repo, { base: "main" });
    expect(diff.oldRev).toBe(shortSha("main"));
    expect(paths(diff.files)).toEqual(["edited.txt", "feature.txt", "main-only.txt"]);
  });

  it("is empty against the current branch", async () => {
    featureBranch();
    writeFileSync(join(repo, "edited.txt"), "dirty\n");
    const head = shortSha("HEAD");
    expect(await gitDiff(repo, { base: "feature" })).toEqual({
      files: [],
      oldRev: head,
      newRev: head,
    });
  });

  it("rejects unknown branches, expressions, options and missing history", async () => {
    featureBranch();
    // As in a clone: `origin/HEAD` must not make `HEAD` a base.
    git("update-ref", "refs/remotes/origin/main", "main");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    for (const base of ["nope", "main~1", "HEAD", "-main", "--all"]) {
      const err = await diffError(repo, { base });
      expect(isApiError(err, "invalid_body"), base).toBe(true);
      expect((err as Error).message).toBe(`unknown branch ${base}`);
    }

    git("checkout", "-q", "--orphan", "unrelated");
    commit("unrelated");
    const err = await diffError(repo, { base: "main" });
    expect(isApiError(err, "invalid_body")).toBe(true);
    expect((err as Error).message).toBe("main and HEAD have no common commit");
  });

  it("rejects a repository without commits", async () => {
    writeFileSync(join(repo, "a.txt"), "a\n");
    const err = await diffError(repo, { base: "main" });
    expect(isApiError(err, "invalid_body")).toBe(true);
    expect((err as Error).message).toBe("no commits yet");
  });

  it("scopes a subfolder cwd to its subtree", async () => {
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "a.txt"), "a\n");
    writeFileSync(join(repo, "top.txt"), "t\n");
    commit();
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(repo, "sub", "a.txt"), "a2\n");
    writeFileSync(join(repo, "top.txt"), "t2\n");
    commit();
    writeFileSync(join(repo, "sub", "a.txt"), "a3\n");

    const diff = await gitDiff(join(repo, "sub"), { base: "main" });
    expect(paths(diff.files)).toEqual(["a.txt"]);
    expect(diff.files[0]?.worktreeChanged).toBe(true);
    expect(diff.files[0]?.patch).toContain("+a2\n");
    const uncommitted = await gitDiff(join(repo, "sub"), { base: "main", uncommitted: true });
    expect(paths(uncommitted.files)).toEqual(["a.txt"]);
    expect(uncommitted.files[0]?.patch).toContain("+a3\n");
  });

  it("checks sizes on the committed blobs", async () => {
    const big = `${"y".repeat(99)}\n`.repeat(Math.ceil(MAX_PATCH_BYTES / 100) + 10);
    writeFileSync(join(repo, "big.txt"), "x\n");
    writeFileSync(join(repo, "gone.txt"), big);
    writeFileSync(join(repo, "small.txt"), "a\n");
    commit();
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(repo, "big.txt"), big);
    unlinkSync(join(repo, "gone.txt"));
    writeFileSync(join(repo, "small.txt"), "b\n");
    commit();
    // The committed copies are what's diffed, whatever the working tree holds.
    writeFileSync(join(repo, "big.txt"), "x\n");
    writeFileSync(join(repo, "small.txt"), big);

    const files = byPath((await gitDiff(repo, { base: "main" })).files);
    expect(files["big.txt"]).toMatchObject({ status: "modified", tooLarge: true });
    expect(files["big.txt"]?.patch).toBeUndefined();
    expect(files["gone.txt"]).toMatchObject({ status: "deleted", tooLarge: true });
    expect(files["small.txt"]).toMatchObject({ tooLarge: false, worktreeChanged: true });
    expect(files["small.txt"]?.patch).toContain("+b");
  });

  it("sizes hundreds of changed files without a git process each", async () => {
    const count = 300;
    // Random, so the two large files aren't paired as a rename.
    const big = () => randomBytes(MAX_PATCH_BYTES).toString("hex");
    mkdirSync(join(repo, "many"));
    writeFileSync(join(repo, "gone.txt"), big());
    commit();
    git("checkout", "-q", "-b", "feature");
    for (let i = 0; i < count; i++) writeFileSync(join(repo, "many", `${i}.txt`), `${i}\n`);
    writeFileSync(join(repo, "big.txt"), big());
    unlinkSync(join(repo, "gone.txt"));
    commit();

    vi.mocked(spawn).mockClear();
    const files = byPath((await gitDiff(repo, { base: "main" })).files);
    expect(vi.mocked(spawn).mock.calls.length).toBeLessThan(20);
    expect(Object.keys(files)).toHaveLength(count + 2);
    expect(files["big.txt"]).toMatchObject({ status: "added", tooLarge: true });
    expect(files["gone.txt"]).toMatchObject({ status: "deleted", tooLarge: true });
    expect(files["many/0.txt"]?.patch).toContain("+0\n");
  });
});

describe("gitDiff of a range", () => {
  it("diffs two commits, naming both, whatever is checked out", async () => {
    writeFileSync(join(repo, "a.txt"), "one\n");
    commit("one");
    const from = git("rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "a.txt"), "two\n");
    commit("two");
    const to = git("rev-parse", "HEAD").trim();
    git("checkout", "-q", from);
    const diff = await gitDiff(repo, { range: { from, to } });
    expect(diff.files.map((f) => [f.status, f.path])).toEqual([["modified", "a.txt"]]);
    expect(diff).toMatchObject({ oldRev: shortSha(from), newRev: shortSha(to) });
  });

  it("pins the hunk options against the repository's diff config", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    writeFileSync(join(repo, "context.txt"), `${lines.join("\n")}\n`);
    // Myers' paper example: myers and histogram match its lines differently.
    writeFileSync(join(repo, "algorithm.txt"), "a\nb\nc\na\nb\nb\na\n");
    writeFileSync(join(repo, "indent.c"), "int f() {\n\tif (a) {\n\t\ta();\n\t}\n\treturn 0;\n}\n");
    commit("one");
    const from = git("rev-parse", "HEAD").trim();
    const changed = lines.map((l, i) => (i === 10 || i === 18 || i === 30 ? `${l} changed` : l));
    writeFileSync(join(repo, "context.txt"), `${changed.join("\n")}\n`);
    writeFileSync(join(repo, "algorithm.txt"), "c\nb\na\nb\na\nc\n");
    // The added block can slide by one line; the indent heuristic picks where it starts.
    writeFileSync(
      join(repo, "indent.c"),
      "int f() {\n\tif (a) {\n\t\tb();\n\t}\n\tif (a) {\n\t\ta();\n\t}\n\treturn 0;\n}\n",
    );
    commit("two");
    const to = git("rev-parse", "HEAD").trim();

    const settings = [
      "diff.context=10",
      "diff.algorithm=histogram",
      "diff.interHunkContext=20",
      "diff.indentHeuristic=false",
    ];
    // Each setting alone changes git's own output for this fixture, so each pin is exercised.
    const defaults = [
      "diff.context=3",
      "diff.algorithm=myers",
      "diff.interHunkContext=0",
      "diff.indentHeuristic=true",
    ];
    const plain = (...config: string[]) =>
      git(...[...defaults, ...config].flatMap((c) => ["-c", c]), "diff", "--no-color", from, to);
    for (const setting of settings) expect(plain(setting)).not.toBe(plain());

    const patches = async () =>
      (await gitDiff(repo, { range: { from, to } })).files.map((f) => [f.path, f.patch]);
    const pinned = await patches();
    expect(pinned.map(([, patch]) => patch?.split("\n").filter((l) => l.startsWith("@@")))).toEqual(
      [
        ["@@ -1,7 +1,6 @@"],
        ["@@ -8,7 +8,7 @@ line 6", "@@ -16,7 +16,7 @@ line 14", "@@ -28,7 +28,7 @@ line 26"],
        ["@@ -1,4 +1,7 @@"],
      ],
    );
    for (const setting of settings) git("config", ...setting.split("="));
    expect(await patches()).toEqual(pinned);
  });

  it("pins the rename limit against the repository's diff config", async () => {
    const lines = (name: string) => Array.from({ length: 20 }, (_, i) => `${name} ${i}\n`).join("");
    writeFileSync(join(repo, "a.txt"), lines("a"));
    writeFileSync(join(repo, "b.txt"), lines("b"));
    commit("one");
    const from = git("rev-parse", "HEAD").trim();
    for (const name of ["a", "b"]) {
      git("mv", `${name}.txt`, `${name}-moved.txt`);
      writeFileSync(join(repo, `${name}-moved.txt`), `${lines(name)}extra\n`);
    }
    commit("two");
    const to = git("rev-parse", "HEAD").trim();
    // Two sources and two destinations pass a limit of 1: git itself skips the edited renames
    // (and warns on stderr, kept out of the test output).
    git("config", "diff.renameLimit", "1");
    const plain = execFileSync("git", ["diff", "-M", "--name-status", from, to], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(plain).not.toContain("R");

    const { files } = await gitDiff(repo, { range: { from, to } });
    expect(files.map((f) => [f.status, f.oldPath, f.path])).toEqual([
      ["renamed", "a.txt", "a-moved.txt"],
      ["renamed", "b.txt", "b-moved.txt"],
    ]);
  });

  it("fails with git_failed when a commit is missing", async () => {
    writeFileSync(join(repo, "a.txt"), "one\n");
    commit("one");
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const error = await diffError(repo, { range: { from: missing, to: "HEAD" } });
    expect(isApiError(error, "git_failed")).toBe(true);
  });
});

describe("gitStatus", () => {
  it("reports the branch and whether tracked files changed", async () => {
    writeFileSync(join(repo, "a.txt"), "a\n");
    commit();
    expect(await gitStatus(repo)).toEqual({ branch: "main", dirty: false });
    writeFileSync(join(repo, "untracked.txt"), "u\n");
    expect(await gitStatus(repo)).toEqual({ branch: "main", dirty: false });
    writeFileSync(join(repo, "a.txt"), "b\n");
    expect(await gitStatus(repo)).toEqual({ branch: "main", dirty: true });
    git("checkout", "-q", "-b", "feature");
    expect((await gitStatus(repo))?.branch).toBe("feature");
  });

  it("shows the short commit id on a detached HEAD", async () => {
    writeFileSync(join(repo, "a.txt"), "a\n");
    commit();
    const sha = git("rev-parse", "--short", "HEAD").trim();
    git("checkout", "-q", "--detach");
    expect(await gitStatus(repo)).toEqual({ branch: sha, dirty: false });
  });
});
