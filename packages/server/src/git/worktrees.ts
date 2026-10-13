/**
 * Creating and removing linked worktrees of `<repo>/main` layout repos
 * (design/06-worktrees.md, "Server").
 */
import { lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import { layoutOf, mainCheckoutIn } from "../catalog/layout.ts";
import { ApiError } from "../errors.ts";
import { canonicalPath } from "../paths.ts";
import { GitError, gitFailed, type RunGitOptions, runGit } from "./git.ts";
import { fetchOrigin } from "./refs.ts";

/** `git worktree add`. */
const SLOW_GIT_TIMEOUT_MS = 60_000;
/**
 * `git worktree remove`: deleting `node_modules` can take minutes, and a kill mid-delete can
 * leave a folder without its `.git` file, which can't be removed from here anymore.
 */
const REMOVE_TIMEOUT_MS = 10 * 60_000;

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/** `runGit`, with every failure as `git_failed`. */
async function git(cwd: string, args: readonly string[], opts: RunGitOptions = {}) {
  try {
    return await runGit(cwd, args, opts);
  } catch (e) {
    throw gitFailed(args, e);
  }
}

async function refExists(main: string, ref: string): Promise<boolean> {
  const { code } = await git(main, ["show-ref", "--verify", "--quiet", ref], { okCodes: [0, 1] });
  return code === 0;
}

/** Folder name: one segment, no control characters, not starting with `.`. */
function validName(name: string): boolean {
  return name !== "" && !name.includes("/") && !name.startsWith(".") && !/\p{Cc}/u.test(name);
}

/** A new branch name: valid for `git branch`, as given (no `@{-1}` expansion), not `@`. */
async function validBranch(main: string, branch: string): Promise<boolean> {
  if (branch === "@") return false;
  const { code, stdout } = await git(main, ["check-ref-format", "--branch", branch], {
    okCodes: [0, 1, 128],
  });
  return code === 0 && stdout === `${branch}\n`;
}

export interface CreateWorktreeRequest {
  /** `$HOME`: `repo` must be inside it. */
  home: string;
  /** The layout container. */
  repo: string;
  name: string;
  /** Default: `name`. */
  branch?: string;
  /** Default: `origin/main`, else `origin/master`. */
  base?: string;
}

/**
 * Fetches `origin` and adds the linked worktree `<repo>/<name>` on the new branch `branch`,
 * started at `base`. Returns its path.
 */
export async function createWorktree(req: CreateWorktreeRequest): Promise<string> {
  const repo = await canonicalPath(req.repo, req.home);
  const main = layoutOf(repo)?.role === "container" ? mainCheckoutIn(repo) : undefined;
  if (main === undefined) {
    throw new ApiError("not_in_layout", `${repo} is not a <repo>/main layout container`);
  }

  const { name, branch = req.name, base } = req;
  if (!validName(name)) {
    throw new ApiError(
      "invalid_body",
      "name must be one folder name, without / or control characters, not starting with .",
    );
  }
  if (!(await validBranch(main, branch))) {
    throw new ApiError("invalid_body", `not a valid branch name: ${branch}`);
  }
  if (base !== undefined && (base === "" || base.startsWith("-"))) {
    throw new ApiError("invalid_body", `not a valid base: ${base}`);
  }

  // Checked before the fetch, so a doomed request spends no network.
  const path = join(repo, name);
  if (await exists(path)) throw new ApiError("worktree_exists", `${path} already exists`);
  if (await refExists(main, `refs/heads/${branch}`)) {
    throw new ApiError("branch_exists", `branch ${branch} already exists`);
  }

  await fetchOrigin(main);

  let start = base;
  if (start === undefined) {
    if (await refExists(main, "refs/remotes/origin/main")) start = "origin/main";
    else if (await refExists(main, "refs/remotes/origin/master")) start = "origin/master";
    else throw new ApiError("invalid_body", "origin has no main or master branch; pass a base");
  }
  const { code } = await git(
    main,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${start}^{commit}`],
    { okCodes: [0, 1, 128] },
  );
  if (code !== 0) throw new ApiError("invalid_body", `base is not a commit: ${start}`);

  await git(main, ["worktree", "add", "-b", branch, path, start], {
    timeoutMs: SLOW_GIT_TIMEOUT_MS,
  });
  return path;
}

/**
 * Whether the worktree at `path` holds submodules, by git's own test: a `<gitdir>/modules`
 * directory, or a gitlink whose folder has a `.git`. Uninitialized gitlinks don't count.
 */
async function hasSubmodules(path: string): Promise<boolean> {
  const gitDir = (await git(path, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
  const modules = await stat(join(gitDir, "modules")).catch(() => undefined);
  if (modules?.isDirectory()) return true;
  const { stdout } = await git(path, ["ls-files", "--stage", "-z"]);
  // Entries are `<mode> <object> <stage>\t<path>`; mode 160000 is a gitlink.
  const gitlinks = stdout
    .split("\0")
    .filter((entry) => entry.startsWith("160000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
  for (const gitlink of gitlinks) {
    if (await exists(join(path, gitlink, ".git"))) return true;
  }
  return false;
}

/**
 * `worktree_dirty` when plain `git worktree remove` would refuse the worktree at `path`: it has
 * uncommitted changes, untracked files or submodules. A missing folder passes.
 */
export async function assertClean(path: string): Promise<void> {
  if (!(await exists(path))) return;
  const { stdout } = await git(path, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (stdout !== "" || (await hasSubmodules(path))) {
    throw new ApiError("worktree_dirty", `${path} has uncommitted changes or submodules`);
  }
}

/** git's refusals of a plain `git worktree remove`: what `assertClean` checks. */
const DIRTY_REFUSAL = /contains modified or untracked files|containing submodules/;

/**
 * `git worktree remove [--force] <path>` from its main checkout `main`; prunes the record of a
 * missing folder. Keeps the branch. `worktree_dirty` when git refuses a plain remove.
 */
export async function removeWorktree(main: string, path: string, force: boolean): Promise<void> {
  const args = ["worktree", "remove", ...(force ? ["--force"] : []), path];
  try {
    await runGit(main, args, { timeoutMs: REMOVE_TIMEOUT_MS });
  } catch (e) {
    // Already pruned (a retry, or a manual `git worktree prune`): nothing left to remove.
    if (
      e instanceof GitError &&
      e.stderr.includes("is not a working tree") &&
      !(await exists(path))
    ) {
      return;
    }
    // Changed after `assertClean`.
    if (!force && e instanceof GitError && DIRTY_REFUSAL.test(e.stderr)) {
      throw new ApiError("worktree_dirty", `${path} has uncommitted changes or submodules`);
    }
    throw gitFailed(args, e);
  }
}
