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

describe("gitDiff", () => {
  it("covers modified, added, deleted, renamed, untracked and binary files", async () => {
    writeFileSync(join(repo, "modified.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "deleted.txt"), "bye\n");
    writeFileSync(join(repo, "old name.txt"), "a stable file\nwith enough\nlines to be\nrenamed\n");
    writeFileSync(join(repo, "image.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
    commit();

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

    const files = byPath(await gitDiff(repo));
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

    const files = byPath(await gitDiff(repo));
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
    const files = byPath(await gitDiff(repo));
    expect(files["staged.txt"]).toMatchObject({ status: "added" });
    expect(files["staged.txt"]?.patch).toContain("+s");
    expect(files["loose.txt"]).toMatchObject({ status: "untracked" });
    expect(await gitStatus(repo)).toEqual({ branch: "main", dirty: true });
  });

  it("is empty for a clean repo and works from a subdirectory", async () => {
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "f.txt"), "f\n");
    writeFileSync(join(repo, "top.txt"), "t\n");
    commit();
    expect(await gitDiff(repo)).toEqual([]);
    writeFileSync(join(repo, "top.txt"), "changed\n");
    const files = await gitDiff(join(repo, "sub"));
    expect(files.map((f) => f.path)).toEqual(["top.txt"]);
  });

  it("falls back to per-file diffs when a type changes", async () => {
    writeFileSync(join(repo, "t.txt"), "target\n");
    writeFileSync(join(repo, "link"), "plain\n");
    commit();
    unlinkSync(join(repo, "link"));
    execFileSync("ln", ["-s", "t.txt", "link"], { cwd: repo });
    writeFileSync(join(repo, "t.txt"), "target 2\n");
    const files = byPath(await gitDiff(repo));
    expect(files.link).toMatchObject({ status: "modified" });
    expect(files.link?.patch).toContain("+t.txt");
    expect(files["t.txt"]?.patch).toContain("+target 2");
  });

  it("rejects a directory outside any work tree", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    let err: unknown;
    try {
      await gitDiff(plain);
    } catch (e) {
      err = e;
    }
    expect(isApiError(err, "not_a_git_repo")).toBe(true);
    expect(await gitStatus(plain)).toBeNull();
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
