/**
 * Creating and removing linked worktrees of `<repo>/main` layout repos
 * (design/06-worktrees.md, "Server"), and the review worktrees of PR reviews
 * (design/11-pr-guide.md, "Review worktrees").
 */
import { lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import { layoutOf, mainCheckoutIn } from "../catalog/layout.ts";
import { ApiError } from "../errors.ts";
import { canonicalPath } from "../paths.ts";
import { GitError, gitFailed, gitTopLevel, type RunGitOptions, runGit } from "./git.ts";
import { fetchPr } from "./pr.ts";
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

/** The canonical layout container `repo` (inside `home`) and its main checkout. */
async function layoutContainer(
  home: string,
  path: string,
): Promise<{ repo: string; main: string }> {
  const repo = await canonicalPath(path, home);
  const main = layoutOf(repo)?.role === "container" ? mainCheckoutIn(repo) : undefined;
  if (main === undefined) {
    throw new ApiError("not_in_layout", `${repo} is not a <repo>/main layout container`);
  }
  return { repo, main };
}

/** `worktree_exists` when `path` exists, `branch_exists` when the local branch does. */
async function assertAvailable(main: string, path: string, branch: string): Promise<void> {
  if (await exists(path)) throw new ApiError("worktree_exists", `${path} already exists`);
  if (await refExists(main, `refs/heads/${branch}`)) {
    throw new ApiError("branch_exists", `branch ${branch} already exists`);
  }
}

/**
 * Fetches `origin` and adds the linked worktree `<repo>/<name>` on the new branch `branch`,
 * started at `base`. Returns its path.
 */
export async function createWorktree(req: CreateWorktreeRequest): Promise<string> {
  const { repo, main } = await layoutContainer(req.home, req.repo);

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
  await assertAvailable(main, path, branch);

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
 * Whether the checkout at `path` has no uncommitted changes, untracked files or submodules: what
 * plain `git worktree remove` requires. A missing folder counts as clean.
 */
export async function isClean(path: string): Promise<boolean> {
  if (!(await exists(path))) return true;
  const { stdout } = await git(path, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  return stdout === "" && !(await hasSubmodules(path));
}

/** `worktree_dirty` when plain `git worktree remove` would refuse the worktree at `path`. */
export async function assertClean(path: string): Promise<void> {
  if (!(await isClean(path))) {
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

/**
 * The git-config key marking `branch` as a review branch: `branch.<name>.pi-code-review` holds the
 * PR's number. It goes away with the branch.
 */
function reviewMarker(branch: string): string {
  return `branch.${branch}.pi-code-review`;
}

/** The PR number `branch` is marked with, if any. */
async function reviewMarkOf(main: string, branch: string): Promise<string | undefined> {
  const { code, stdout } = await git(main, ["config", "--get", reviewMarker(branch)], {
    okCodes: [0, 1],
  });
  return code === 0 ? stdout.trim() : undefined;
}

/** The folder name of PR `number`'s review worktree in its layout container. */
export function reviewWorktreeName(number: number): string {
  return `pr-${number}`;
}

/** The branch checked out in each of `main`'s worktrees, by path (folders may be missing). */
async function checkedOutBranches(main: string): Promise<Map<string, string>> {
  const { stdout } = await git(main, ["worktree", "list", "--porcelain", "-z"]);
  const branches = new Map<string, string>();
  let current: string | undefined;
  for (const field of stdout.split("\0")) {
    if (field.startsWith("worktree ")) current = field.slice("worktree ".length);
    else if (current !== undefined && field.startsWith("branch refs/heads/")) {
      branches.set(current, field.slice("branch refs/heads/".length));
    }
  }
  return branches;
}

/**
 * Deletes `branch` when it is a leftover of PR `number`'s review: marked with that number and
 * checked out in no worktree, as after a removal whose `git branch -D` failed.
 */
async function deleteLeftoverReviewBranch(
  main: string,
  branch: string,
  number: number,
): Promise<void> {
  if (!(await refExists(main, `refs/heads/${branch}`))) return;
  if ((await reviewMarkOf(main, branch)) !== String(number)) return;
  if ([...(await checkedOutBranches(main)).values()].includes(branch)) return;
  await deleteBranch(main, branch);
}

export interface AddReviewWorktreeRequest {
  /** `$HOME`: `repo` must be inside it. */
  home: string;
  /** The layout container. */
  repo: string;
  /** The PR's number. */
  number: number;
  /** The PR's head branch. */
  branch: string;
}

/**
 * Adds the review worktree `<repo>/pr-<number>` on a new local branch named after the PR's head
 * branch, fetched from `origin` and tracking `origin/<branch>`, and marks the branch as a review
 * branch. When the head branch is gone from `origin` (a merged or closed PR's, deleted), the
 * branch starts at `refs/pull/<number>/head` instead, with no upstream. Returns its path. A
 * leftover review branch of this PR is deleted first; throws `worktree_exists` or
 * `branch_exists` before fetching anything. A failure after the fetch removes what was created.
 */
export async function addReviewWorktree(req: AddReviewWorktreeRequest): Promise<string> {
  const { repo, main } = await layoutContainer(req.home, req.repo);
  const { branch, number } = req;
  if (!(await validBranch(main, branch))) {
    throw new ApiError("invalid_body", `the PR's head branch isn't a valid branch name: ${branch}`);
  }
  const path = join(repo, reviewWorktreeName(number));
  await deleteLeftoverReviewBranch(main, branch, number);
  await assertAvailable(main, path, branch);

  const remote = `refs/remotes/origin/${branch}`;
  let start = remote;
  try {
    await fetchOrigin(main, [`+refs/heads/${branch}:${remote}`]);
  } catch (e) {
    if (!(e instanceof ApiError && e.message.includes("couldn't find remote ref"))) throw e;
    start = await pullHead(main, number, branch);
  }
  try {
    // The upstream is set by hand: `--track` refuses a start point that origin's fetch refspec
    // doesn't map, as in single-branch clones.
    await git(main, ["worktree", "add", "--no-track", "-b", branch, path, start], {
      timeoutMs: SLOW_GIT_TIMEOUT_MS,
    });
    if (start === remote) {
      await git(main, ["config", `branch.${branch}.remote`, "origin"]);
      await git(main, ["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
    }
    await git(main, ["config", reviewMarker(branch), String(number)]);
  } catch (e) {
    // Neither the branch nor the folder existed before (`assertAvailable`).
    await discardReviewWorktree(main, path, branch).catch(() => {});
    throw e;
  }
  return path;
}

/** PR `number`'s head as fetched from `refs/pull/<number>/head`; `git_failed` when it's missing. */
async function pullHead(main: string, number: number, branch: string): Promise<string> {
  try {
    return (await fetchPr(main, number, "")).headSha;
  } catch (e) {
    if (e instanceof ApiError && e.message.includes("couldn't find remote ref")) {
      throw new ApiError(
        "git_failed",
        `neither the PR's head branch ${branch} nor refs/pull/${number}/head is on origin`,
      );
    }
    throw e;
  }
}

/**
 * Removes a review worktree just created and its branch, unpushed commits included (a review
 * that couldn't start); either may be missing, as after a `git worktree add` that failed. Both
 * are attempted; throws `git_failed` when either fails.
 */
export async function discardReviewWorktree(
  main: string,
  path: string,
  branch: string,
): Promise<void> {
  let failure: unknown;
  await removeWorktree(main, path, true).catch((e: unknown) => {
    failure = e;
  });
  try {
    if (await refExists(main, `refs/heads/${branch}`)) await deleteBranch(main, branch);
  } catch (e) {
    failure ??= e;
  }
  if (failure !== undefined) throw failure;
}

/** `git branch -D <branch>` from the main checkout `main`. */
export async function deleteBranch(main: string, branch: string): Promise<void> {
  await git(main, ["branch", "-D", branch]);
}

/**
 * The branch checked out in the linked worktree at `path`, as `main` lists it (the folder may be
 * missing), when it is marked as a review branch.
 */
export async function reviewBranchAt(main: string, path: string): Promise<string | undefined> {
  const branch = (await checkedOutBranches(main)).get(path);
  if (branch === undefined) return undefined;
  return (await reviewMarkOf(main, branch)) === undefined ? undefined : branch;
}

/**
 * The top level of the checkout holding `cwd` when it is the review worktree of PR `number`: its
 * branch carries the review marker with that number.
 */
export async function reviewWorktreeOf(cwd: string, number: number): Promise<string | undefined> {
  const top = await gitTopLevel(cwd);
  if (top === null) return undefined;
  const { code, stdout } = await git(top, ["symbolic-ref", "--quiet", "HEAD"], {
    okCodes: [0, 1],
  });
  const ref = stdout.trim();
  if (code !== 0 || !ref.startsWith("refs/heads/")) return undefined;
  const branch = ref.slice("refs/heads/".length);
  return (await reviewMarkOf(top, branch)) === String(number) ? top : undefined;
}

/** The commit checked out at `path`. */
export async function headOf(path: string): Promise<string> {
  return (await git(path, ["rev-parse", "HEAD"])).stdout.trim();
}

/** `git reset --hard <sha>` in the checkout at `path`. */
export async function resetHard(path: string, sha: string): Promise<void> {
  await git(path, ["reset", "--quiet", "--hard", sha], { timeoutMs: SLOW_GIT_TIMEOUT_MS });
}
