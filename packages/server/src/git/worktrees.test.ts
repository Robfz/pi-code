import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isApiError } from "../errors.ts";
import { git, type LayoutRepo, makeLayoutRepo } from "../testing/layout-repo.ts";
import {
  assertClean,
  type CreateWorktreeRequest,
  createWorktree,
  removeWorktree,
} from "./worktrees.ts";

let home: string;
let layout: LayoutRepo;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-worktrees-")));
  layout = makeLayoutRepo(home, "repo");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function create(req: Partial<CreateWorktreeRequest> & { name: string }): Promise<string> {
  return createWorktree({ home, repo: layout.repo, ...req });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (isApiError(e)) return e.code;
    throw e;
  }
  throw new Error("expected a rejection");
}

function upstreamOf(cwd: string, branch: string): string | undefined {
  try {
    return git(cwd, "rev-parse", "--abbrev-ref", `${branch}@{upstream}`).trim();
  } catch {
    return undefined;
  }
}

const headOf = (cwd: string) => git(cwd, "symbolic-ref", "--short", "HEAD").trim();
const branches = (cwd: string) => git(cwd, "branch", "--format=%(refname:short)").split("\n");
const worktreeList = (cwd: string) => git(cwd, "worktree", "list", "--porcelain");

describe("createWorktree", () => {
  it("defaults the branch to the name and the base to origin/main, tracking it", async () => {
    // A commit on origin after the clone: the fetch makes it the base.
    const other = join(home, "other");
    git(home, "clone", "-q", layout.origin, other);
    git(other, "commit", "-q", "--allow-empty", "-m", "later");
    git(other, "push", "-q", "origin", "HEAD:main");

    const path = await create({ name: "wt" });
    expect(path).toBe(join(layout.repo, "wt"));
    expect(headOf(path)).toBe("wt");
    expect(upstreamOf(path, "wt")).toBe("origin/main");
    expect(git(path, "log", "-1", "--format=%s").trim()).toBe("later");
  });

  it("falls back to origin/master", async () => {
    layout = makeLayoutRepo(home, "m", { branches: ["master"] });
    const path = await create({ name: "wt" });
    expect(upstreamOf(path, "wt")).toBe("origin/master");
  });

  it("fails without origin/main or origin/master", async () => {
    layout = makeLayoutRepo(home, "t", { branches: ["trunk"] });
    expect(await codeOf(create({ name: "wt" }))).toBe("invalid_body");
    expect(existsSync(join(layout.repo, "wt"))).toBe(false);
  });

  it("starts at an explicit base, tracking only remote-tracking ones", async () => {
    git(layout.main, "push", "-q", "origin", "HEAD:refs/heads/dev");
    const remote = await create({ name: "r", base: "origin/dev" });
    expect(upstreamOf(remote, "r")).toBe("origin/dev");
    const local = await create({ name: "l", base: "main" });
    expect(headOf(local)).toBe("l");
    expect(upstreamOf(local, "l")).toBeUndefined();
    expect(await codeOf(create({ name: "x", base: "nope" }))).toBe("invalid_body");
    expect(await codeOf(create({ name: "y", base: "--orphan" }))).toBe("invalid_body");
  });

  it("accepts a branch with a slash", async () => {
    const path = await create({ name: "x", branch: "feature/x" });
    expect(headOf(path)).toBe("feature/x");
  });

  it("rejects invalid names and branches", async () => {
    for (const name of [".git", ".x", ".", "..", "a/b", "", "a\u0001b", "a\nb"]) {
      expect(await codeOf(create({ name })), JSON.stringify(name)).toBe("invalid_body");
    }
    // `@{-1}` would expand to the previously checked-out branch.
    git(layout.main, "checkout", "-q", "-b", "previous");
    git(layout.main, "checkout", "-q", "main");
    for (const branch of ["@", "@{-1}", "a b", "-x", "HEAD"]) {
      expect(await codeOf(create({ name: "wt", branch })), branch).toBe("invalid_body");
    }
    expect(branches(layout.main)).not.toContain("wt");
  });

  it("refuses an existing folder or branch", async () => {
    mkdirSync(join(layout.repo, "taken"));
    expect(await codeOf(create({ name: "taken" }))).toBe("worktree_exists");
    git(layout.main, "branch", "dup");
    expect(await codeOf(create({ name: "dup" }))).toBe("branch_exists");
    expect(await codeOf(create({ name: "other", branch: "dup" }))).toBe("branch_exists");
  });

  it("fails with git_failed when origin is unreachable", async () => {
    git(layout.main, "remote", "set-url", "origin", join(home, "nowhere.git"));
    const e = await create({ name: "wt" }).catch((err: unknown) => err);
    expect(isApiError(e, "git_failed")).toBe(true);
    expect((e as Error).message).toMatch(/^git fetch origin failed: /);
    expect(existsSync(join(layout.repo, "wt"))).toBe(false);
  });

  it("fetches with core.sshCommand when it is set", async () => {
    const saved = { GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND, GIT_SSH: process.env.GIT_SSH };
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH;
    try {
      const marker = join(home, "ssh-ran");
      git(layout.main, "remote", "set-url", "origin", "ssh://nowhere.invalid/repo.git");
      git(layout.main, "config", "core.sshCommand", `touch '${marker}'; false`);
      expect(await codeOf(create({ name: "wt" }))).toBe("git_failed");
      expect(existsSync(marker)).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });

  it("only creates in a layout container inside $HOME", async () => {
    expect(await codeOf(create({ name: "wt", repo: layout.main }))).toBe("not_in_layout");
    expect(await codeOf(create({ name: "wt", repo: home }))).toBe("not_in_layout");
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-outside-")));
    try {
      const elsewhere = makeLayoutRepo(outside, "r");
      expect(await codeOf(create({ name: "wt", repo: elsewhere.repo }))).toBe("outside_home");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

const addSubmodule = (path: string) => {
  git(path, "-c", "protocol.file.allow=always", "submodule", "add", "-q", layout.origin, "sub");
  git(path, "commit", "-q", "-m", "submodule");
};

describe("assertClean", () => {
  it("passes a clean worktree and a missing folder", async () => {
    const path = await create({ name: "wt" });
    await assertClean(path);
    await assertClean(join(layout.repo, "gone"));
  });

  it("refuses changes and untracked files", async () => {
    const path = await create({ name: "wt" });
    writeFileSync(join(path, "untracked.txt"), "x\n");
    expect(await codeOf(assertClean(path))).toBe("worktree_dirty");
    git(path, "add", "untracked.txt");
    expect(await codeOf(assertClean(path))).toBe("worktree_dirty");
  });

  it("refuses exactly the submodules that make git worktree remove refuse", async () => {
    const withSub = await create({ name: "with-sub" });
    addSubmodule(withSub);
    expect(await codeOf(assertClean(withSub))).toBe("worktree_dirty");

    // Same commit, submodule not initialized: git removes it.
    const uninit = join(layout.repo, "uninit");
    git(layout.main, "worktree", "add", "-q", "-b", "uninit", uninit, "with-sub");
    await assertClean(uninit);
    await removeWorktree(layout.main, uninit, false);
    expect(existsSync(uninit)).toBe(false);

    // Deinitialized: `<gitdir>/modules` remains, and git still refuses.
    const deinit = join(layout.repo, "deinit");
    git(layout.main, "worktree", "add", "-q", "-b", "deinit", deinit, "with-sub");
    git(deinit, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init");
    git(deinit, "submodule", "deinit", "-q", "sub");
    expect(await codeOf(assertClean(deinit))).toBe("worktree_dirty");
    expect(await codeOf(removeWorktree(layout.main, deinit, false))).toBe("worktree_dirty");

    // An embedded repository committed as a gitlink, without .gitmodules.
    const nested = await create({ name: "nested" });
    git(nested, "init", "-q", "inner");
    git(join(nested, "inner"), "commit", "-q", "--allow-empty", "-m", "inner");
    git(nested, "add", "inner");
    git(nested, "commit", "-q", "-m", "inner");
    expect(await codeOf(assertClean(nested))).toBe("worktree_dirty");
    expect(await codeOf(removeWorktree(layout.main, nested, false))).toBe("worktree_dirty");
  });
});

describe("removeWorktree", () => {
  it("removes a clean worktree and keeps its branch", async () => {
    const path = await create({ name: "wt" });
    await removeWorktree(layout.main, path, false);
    expect(existsSync(path)).toBe(false);
    expect(worktreeList(layout.main)).not.toContain(path);
    expect(branches(layout.main)).toContain("wt");
  });

  it("refuses changes as worktree_dirty unless forced", async () => {
    const path = await create({ name: "wt" });
    writeFileSync(join(path, "untracked.txt"), "x\n");
    expect(await codeOf(removeWorktree(layout.main, path, false))).toBe("worktree_dirty");
    expect(existsSync(path)).toBe(true);
    await removeWorktree(layout.main, path, true);
    expect(existsSync(path)).toBe(false);
  });

  it("removes submodules when forced", async () => {
    const path = await create({ name: "wt" });
    addSubmodule(path);
    expect(await codeOf(removeWorktree(layout.main, path, false))).toBe("worktree_dirty");
    await removeWorktree(layout.main, path, true);
    expect(existsSync(path)).toBe(false);
  });

  it("prunes the record of a missing folder, and accepts an already pruned one", async () => {
    const missing = await create({ name: "missing" });
    rmSync(missing, { recursive: true });
    await removeWorktree(layout.main, missing, false);
    expect(worktreeList(layout.main)).not.toContain(missing);

    const pruned = await create({ name: "pruned" });
    rmSync(pruned, { recursive: true });
    git(layout.main, "worktree", "prune");
    await removeWorktree(layout.main, pruned, false);
    await removeWorktree(layout.main, pruned, false);
  });
});
