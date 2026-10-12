/**
 * A folder's place in a `<repo>/main` layout, from files only (design/06-worktrees.md,
 * "Layout identity").
 */
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { RepoLayout } from "@pi-code/protocol";
import { findGitDir } from "../git/branches.ts";

const MAIN_NAMES = ["main", "master"] as const;

export function isDirectory(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

/**
 * The main checkout of the container `repo`: its `main` or `master` folder holding a `.git`
 * directory, with `repo` outside any git work tree. `undefined` when neither or both qualify.
 */
export function mainCheckoutIn(repo: string): string | undefined {
  const found = MAIN_NAMES.map((name) => join(repo, name)).filter((m) =>
    isDirectory(join(m, ".git")),
  );
  if (found.length !== 1 || findGitDir(repo) !== undefined) return undefined;
  return found[0];
}

/** Whether `m` is the main checkout of its parent folder. */
function isMainCheckout(m: string): boolean {
  return mainCheckoutIn(dirname(m)) === m;
}

/**
 * The checkout owning the common git dir of the linked worktree at `path`: `<g>/commondir` of
 * the `gitdir: <g>` in `path/.git`, when that common dir is named `.git`. `undefined` for
 * submodules (no `commondir`), bare repos and anything unreadable.
 */
function commonCheckoutOf(path: string): string | undefined {
  const dotGit = join(path, ".git");
  if (!statSync(dotGit, { throwIfNoEntry: false })?.isFile()) return undefined;
  const gitDir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
  if (gitDir === undefined) return undefined;
  const g = resolve(path, gitDir);
  let commonDir: string;
  try {
    commonDir = resolve(g, readFileSync(join(g, "commondir"), "utf8").trim());
  } catch {
    return undefined;
  }
  return basename(commonDir) === ".git" ? dirname(commonDir) : undefined;
}

/** `cwd`'s layout (absolute path), or `undefined` outside a layout repo. Never throws. */
export function layoutOf(cwd: string): RepoLayout | undefined {
  if (!isAbsolute(cwd)) return undefined;
  try {
    const dotGit = statSync(join(cwd, ".git"), { throwIfNoEntry: false });
    if (dotGit?.isDirectory()) {
      return isMainCheckout(cwd) ? { repo: dirname(cwd), role: "main", main: cwd } : undefined;
    }
    if (dotGit?.isFile()) {
      const m = commonCheckoutOf(cwd);
      return m !== undefined && isMainCheckout(m)
        ? { repo: dirname(m), role: "worktree", main: m }
        : undefined;
    }
    if (statSync(cwd, { throwIfNoEntry: false }) !== undefined) {
      const main = mainCheckoutIn(cwd);
      return main !== undefined ? { repo: cwd, role: "container", main } : undefined;
    }
    const repo = dirname(cwd);
    const main = mainCheckoutIn(repo);
    return main !== undefined ? { repo, role: "worktree", main, missing: true } : undefined;
  } catch {
    return undefined;
  }
}
