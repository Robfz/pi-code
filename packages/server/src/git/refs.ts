/**
 * Branch listing, default-branch detection and fetching `origin` (design/07-code-review.md,
 * "GET git/branches" and "POST git/fetch").
 */
import type { GitBranchesResponse } from "@pi-code/protocol";
import { gitFailed, requireWorkTree, runGit } from "./git.ts";

const HEADS_PREFIX = "refs/heads/";
const ORIGIN_PREFIX = "refs/remotes/origin/";
const FETCH_TIMEOUT_MS = 60_000;

/**
 * The branches of the repo containing `cwd`, local and on `origin` (named without `origin/`,
 * once each, `origin/HEAD` left out), most recent commit first, and the default branch: the one
 * `origin/HEAD` names when it is listed, else `main`, else `master`, else `null`. Throws
 * `not_a_git_repo` outside a work tree.
 */
export async function listBranches(cwd: string): Promise<GitBranchesResponse> {
  await requireWorkTree(cwd);
  // Full ref names, prefixes stripped here: `refname:short` writes `heads/x` when a tag is also
  // named `x`, and would blur a local `x` with `origin/x`.
  const [listed, originHead] = await Promise.all([
    runGit(cwd, [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes/origin",
    ]),
    runGit(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { okCodes: [0, 1, 128] }),
  ]);
  const names = new Set<string>();
  for (const ref of listed.stdout.split("\n")) {
    if (ref.startsWith(HEADS_PREFIX)) names.add(ref.slice(HEADS_PREFIX.length));
    else if (ref.startsWith(ORIGIN_PREFIX) && ref !== `${ORIGIN_PREFIX}HEAD`) {
      names.add(ref.slice(ORIGIN_PREFIX.length));
    }
  }
  const branches = [...names];
  const target = originHead.stdout.trim();
  const candidates = [
    ...(originHead.code === 0 && target.startsWith(ORIGIN_PREFIX)
      ? [target.slice(ORIGIN_PREFIX.length)]
      : []),
    "main",
    "master",
  ];
  const defaultBranch = candidates.find((b) => branches.includes(b)) ?? null;
  return { branches, defaultBranch };
}

/**
 * `ssh -o BatchMode=yes` for `git fetch`, so an ssh passphrase prompt fails instead of waiting
 * for the timeout; nothing when the user picked an ssh command (`GIT_SSH_COMMAND`, `GIT_SSH`,
 * `core.sshCommand`).
 */
async function fetchEnv(cwd: string): Promise<Record<string, string>> {
  if (process.env.GIT_SSH_COMMAND !== undefined || process.env.GIT_SSH !== undefined) return {};
  const { stdout } = await runGit(cwd, ["config", "--get", "core.sshCommand"], { okCodes: [0, 1] });
  return stdout.trim() === "" ? { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } : {};
}

/**
 * Runs `git fetch origin` in `cwd` without prompting for credentials (`runGit` sets
 * `GIT_TERMINAL_PROMPT=0`; ssh runs in batch mode). Throws `git_failed`, with git's stderr, when
 * there is no `origin` or the fetch fails.
 */
export async function fetchOrigin(cwd: string): Promise<void> {
  const args = ["fetch", "origin"];
  try {
    await runGit(cwd, args, { timeoutMs: FETCH_TIMEOUT_MS, env: await fetchEnv(cwd) });
  } catch (e) {
    throw gitFailed(args, e);
  }
}
