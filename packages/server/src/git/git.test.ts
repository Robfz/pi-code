import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitFileDiff } from "@pi-code/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isApiError } from "../errors.ts";
import { gitDiff, gitStatus, MAX_PATCH_BYTES } from "./git.ts";

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
