import {
  type FSWatcher,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderBranches, findGitDir, readHead } from "./branches.ts";

/** Every watch opened, with whether it was closed since. */
const watches = vi.hoisted(() => new Map<string, { closed: boolean }>());

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const watch = (path: string, listener: () => void): FSWatcher => {
    const watcher = fs.watch(path, listener);
    const state = { closed: false };
    watches.set(path, state);
    watcher.on("close", () => {
      state.closed = true;
    });
    return watcher;
  };
  return { ...fs, watch };
});

const SHA = "0123456789abcdef0123456789abcdef01234567";

let root: string;
let branches: FolderBranches | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-branches-")));
});

afterEach(() => {
  branches?.close();
  branches = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** A repo at `<root>/<name>` with `HEAD` as given; returns its work tree. */
function repo(name: string, head: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), head);
  return dir;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(50);
  }
}

describe("git dir and HEAD", () => {
  it("reads the branch of a plain repo, also from a subdirectory", () => {
    const dir = repo("plain", "ref: refs/heads/main\n");
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    expect(findGitDir(join(dir, "src", "deep"))).toBe(join(dir, ".git"));
    expect(readHead(join(dir, ".git"))).toBe("main");
  });

  it("keeps slashes in branch names and other refs without refs/heads/", () => {
    const dir = repo("refs", "ref: refs/heads/feature/x\n");
    expect(readHead(join(dir, ".git"))).toBe("feature/x");
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/remotes/origin/main\n");
    expect(readHead(join(dir, ".git"))).toBe("refs/remotes/origin/main");
  });

  it("shows a detached HEAD as a 7-character commit", () => {
    const dir = repo("detached", `${SHA}\n`);
    expect(readHead(join(dir, ".git"))).toBe("0123456");
  });

  it("follows a worktree's .git file, relative to its directory", () => {
    const main = repo("main", "ref: refs/heads/main\n");
    const wtGitDir = join(main, ".git", "worktrees", "wt");
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/heads/topic\n");
    const wt = join(root, "wt");
    mkdirSync(join(wt, "sub"), { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: ../main/.git/worktrees/wt\n");
    expect(findGitDir(join(wt, "sub"))).toBe(wtGitDir);
    expect(readHead(wtGitDir)).toBe("topic");

    writeFileSync(join(wt, ".git"), `gitdir: ${wtGitDir}\n`);
    expect(findGitDir(wt)).toBe(wtGitDir);
  });

  it("finds nothing outside a work tree, or for a .git file without gitdir", () => {
    mkdirSync(join(root, "plain-dir"));
    expect(findGitDir(join(root, "plain-dir"))).toBeUndefined();
    mkdirSync(join(root, "broken"));
    writeFileSync(join(root, "broken", ".git"), "nonsense\n");
    expect(findGitDir(join(root, "broken"))).toBeUndefined();
    const dir = repo("garbage", "garbage\n");
    expect(readHead(join(dir, ".git"))).toBeUndefined();
  });
});

describe("FolderBranches", () => {
  function track() {
    const changes: [string, string | null][] = [];
    branches = new FolderBranches((cwd, branch) => changes.push([cwd, branch]));
    return { branches, changes };
  }

  it("reports tracked folders' branches; non-repos get no entry", () => {
    const a = repo("a", "ref: refs/heads/main\n");
    const b = repo("b", `${SHA}\n`);
    const none = join(root, "none");
    mkdirSync(none);
    const { branches, changes } = track();
    branches.sync(new Set([a, b, none]));
    expect(changes).toEqual([
      [a, "main"],
      [b, "0123456"],
    ]);
    expect(branches.current()).toEqual({ [a]: "main", [b]: "0123456" });
    branches.sync(new Set([a, b, none]));
    expect(changes).toHaveLength(2);
  });

  it("reports one change for a checkout through a lock-file rename", async () => {
    const dir = repo("checkout", "ref: refs/heads/main\n");
    const { branches, changes } = track();
    branches.sync(new Set([dir]));
    // Repeated until seen: a watch may miss changes made while it is still starting.
    await until(() => {
      writeFileSync(join(dir, ".git", "HEAD.lock"), "ref: refs/heads/feature\n");
      renameSync(join(dir, ".git", "HEAD.lock"), join(dir, ".git", "HEAD"));
      return changes.length === 2;
    });
    await sleep(200);
    expect(changes).toEqual([
      [dir, "main"],
      [dir, "feature"],
    ]);
    expect(branches.current()).toEqual({ [dir]: "feature" });
  });

  it("reports nothing for unrelated git-dir events", async () => {
    const dir = repo("unrelated", "ref: refs/heads/main\n");
    const { branches, changes } = track();
    branches.sync(new Set([dir]));
    writeFileSync(join(dir, ".git", "index"), "x");
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(dir, ".git", "refs", "heads", "main"), `${SHA}\n`);
    await sleep(300);
    expect(changes).toEqual([[dir, "main"]]);
    // The watch is alive: a real change is reported, once.
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/feature\n");
    await until(() => changes.length === 2);
    await sleep(200);
    expect(changes).toEqual([
      [dir, "main"],
      [dir, "feature"],
    ]);
  });

  it("reports null when a folder stops being tracked, and stops watching it", async () => {
    const dir = repo("stop", "ref: refs/heads/main\n");
    const none = join(root, "none");
    mkdirSync(none);
    const { branches, changes } = track();
    branches.sync(new Set([dir, none]));
    expect(watches.get(join(dir, ".git"))).toEqual({ closed: false });
    expect(watches.has(none)).toBe(false);
    branches.sync(new Set());
    expect(changes).toEqual([
      [dir, "main"],
      [dir, null],
    ]);
    expect(branches.current()).toEqual({});
    await until(() => watches.get(join(dir, ".git"))?.closed === true);
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/other\n");
    await sleep(300);
    expect(changes).toHaveLength(2);

    // Tracked again: resolved and read afresh.
    branches.sync(new Set([dir]));
    expect(changes.at(-1)).toEqual([dir, "other"]);
  });

  it("close stops every watch without reporting", async () => {
    const dir = repo("close", "ref: refs/heads/main\n");
    const { branches, changes } = track();
    branches.sync(new Set([dir]));
    branches.close();
    expect(changes).toEqual([[dir, "main"]]);
    expect(branches.current()).toEqual({});
    await until(() => watches.get(join(dir, ".git"))?.closed === true);
  });
});
