/**
 * Git side of PR review (design/10-pr-review.md): the `origin` repo, fetching a PR's commits
 * without a checkout, pinning its base, polling its head, and the hidden refs that keep pinned
 * commits from being garbage-collected.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { PrState } from "@pi-code/protocol";
import { ApiError } from "../errors.ts";
import { parseGithubRemote } from "../pr/github.ts";
import { FULL_SHA, GitError, gitFailed, hasCommit, type RunGitOptions, runGit } from "./git.ts";
import { fetchEnv, fetchOrigin } from "./refs.ts";

const LS_REMOTE_TIMEOUT_MS = 30_000;
/** The most commits an update prompt lists. */
const MAX_COMMITS = 50;

/** Where pinned PR commits are kept: `refs/pi-code/pr/<number>/<sha>`. */
export const PR_REFS_PREFIX = "refs/pi-code/pr/";
/** Where `fetchPr` puts a head and a base for the moment it reads them. */
const FETCH_REFS_PREFIX = "refs/pi-code/fetch/";

/** `runGit`, failing with `git_failed`. */
async function git(cwd: string, args: readonly string[], opts?: RunGitOptions) {
  try {
    return await runGit(cwd, args, opts);
  } catch (e) {
    throw gitFailed(args, e);
  }
}

/**
 * `owner/name` of the `origin` remote as configured (not rewritten by `insteadOf`). Throws
 * `not_a_github_repo` when there is no `origin` or it isn't on GitHub.
 */
export async function originRepo(cwd: string): Promise<string> {
  const { code, stdout } = await git(cwd, ["config", "--get", "remote.origin.url"], {
    okCodes: [0, 1],
  });
  const url = stdout.trim();
  if (code !== 0 || url === "") {
    throw new ApiError("not_a_github_repo", "this repository has no origin remote");
  }
  const repo = parseGithubRemote(url);
  if (repo === undefined) {
    throw new ApiError("not_a_github_repo", `origin (${url}) isn't a GitHub repository`);
  }
  return repo;
}

/** The repository's common git dir (shared by its worktrees), absolute. */
export async function gitCommonDir(cwd: string): Promise<string> {
  const { stdout } = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return stdout.trim();
}

/** `cwd` relative to the repository's top level: `""` there, else ending in `/`. */
export async function repoFolder(cwd: string): Promise<string> {
  const { stdout } = await git(cwd, ["rev-parse", "--show-prefix"]);
  return stdout.replace(/\n$/, "");
}

export interface FetchedPr {
  /** The head as fetched. */
  headSha: string;
  /** The base branch's tip as fetched; `undefined` when the branch is gone. */
  baseTip?: string;
}

/**
 * Fetches PR `number`'s head (`refs/pull/<number>/head`, which GitHub keeps for closed and merged
 * PRs and fork PRs) and its base branch in one fetch, without touching the working tree. Both go
 * to temporary refs of their own, so concurrent fetches (another conversation's, Branch mode's)
 * neither change what is read nor contend for a ref; the head may be newer than what the API
 * reported. A base branch that is gone (a closed PR's) is tolerated by fetching the head alone;
 * any other failure throws `git_failed`.
 */
export async function fetchPr(
  cwd: string,
  number: number,
  baseRefName: string,
): Promise<FetchedPr> {
  const id = randomUUID();
  const headRef = `${FETCH_REFS_PREFIX}${id}-head`;
  const baseRef = `${FETCH_REFS_PREFIX}${id}-base`;
  const head = `+refs/pull/${number}/head:${headRef}`;
  const base = `refs/heads/${baseRefName}`;
  let withBase = baseRefName !== "";
  const resolve = async (ref: string) =>
    (await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
  try {
    try {
      await fetchOrigin(cwd, withBase ? [head, `+${base}:${baseRef}`] : [head]);
    } catch (e) {
      const baseGone =
        e instanceof ApiError && e.message.includes(`couldn't find remote ref ${base}`);
      if (!withBase || !baseGone) throw e;
      withBase = false;
      await fetchOrigin(cwd, [head]);
    }
    const headSha = await resolve(headRef);
    return withBase ? { headSha, baseTip: await resolve(baseRef) } : { headSha };
  } finally {
    for (const ref of [headRef, baseRef]) {
      await runGit(cwd, ["update-ref", "-d", ref]).catch(() => {});
    }
  }
}

/** Fetches a commit by id when it isn't in the object database (GitHub serves reachable ones). */
async function ensureCommit(cwd: string, sha: string): Promise<boolean> {
  if (await hasCommit(cwd, sha)) return true;
  await fetchOrigin(cwd, [sha]).catch(() => {});
  return hasCommit(cwd, sha);
}

interface PinInput {
  state: PrState;
  /** The base branch's tip as fetched (`fetchPr`); `undefined` when the branch is gone. */
  baseTip?: string | undefined;
  /** GitHub's recorded base commit. */
  baseRefOid: string;
  headSha: string;
}

/**
 * The PR diff's old side. Open and closed PRs: the merge-base of the base branch (as just fetched;
 * GitHub's `baseRefOid` when the branch is gone) and the head. Merged PRs: the head is in
 * the base branch by now, so that merge-base would be the head itself; the merge-base of GitHub's
 * recorded base and the head is used instead. Throws `git_failed` when the commits are missing or
 * unrelated.
 */
export async function pinBase(cwd: string, pr: PinInput): Promise<string> {
  const from = pr.state !== "merged" && pr.baseTip !== undefined ? pr.baseTip : pr.baseRefOid;
  if (from === pr.baseRefOid && !(await ensureCommit(cwd, from))) {
    throw new ApiError("git_failed", `the PR's base commit ${from} couldn't be fetched`);
  }
  const { code, stdout } = await git(cwd, ["merge-base", from, pr.headSha], {
    okCodes: [0, 1],
  });
  if (code === 1) {
    throw new ApiError("git_failed", `the PR's base and head ${pr.headSha} have no common commit`);
  }
  return stdout.trim();
}

/** The current head of PR `number` on `origin` (`git ls-remote`), or `undefined` when it has none. */
export async function remotePrHead(cwd: string, number: number): Promise<string | undefined> {
  const { stdout } = await git(cwd, ["ls-remote", "origin", `refs/pull/${number}/head`], {
    timeoutMs: LS_REMOTE_TIMEOUT_MS,
    env: await fetchEnv(cwd),
  });
  const sha = stdout.split(/\s/)[0] ?? "";
  return FULL_SHA.test(sha) ? sha : undefined;
}

export interface FileStat {
  path: string;
  oldPath?: string;
  /** `undefined` for binary files. */
  additions?: number;
  deletions?: number;
}

/** Per-file line counts of `from..to`, repo-relative, renames detected. */
export async function diffStat(cwd: string, from: string, to: string): Promise<FileStat[]> {
  const { stdout } = await git(cwd, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "-M",
    "--numstat",
    "-z",
    from,
    to,
  ]);
  // `<added>\t<deleted>\t<path>\0`, or for a rename `<added>\t<deleted>\t\0<old>\0<new>\0`.
  const parts = stdout.split("\0");
  const files: FileStat[] = [];
  for (let i = 0; i < parts.length; i++) {
    const [added, deleted, path] = (parts[i] as string).split("\t");
    if (added === undefined || deleted === undefined || path === undefined) continue;
    const counts = added === "-" ? {} : { additions: Number(added), deletions: Number(deleted) };
    if (path === "") {
      const oldPath = parts[++i] ?? "";
      files.push({ path: parts[++i] ?? "", oldPath, ...counts });
    } else files.push({ path, ...counts });
  }
  return files;
}

export interface CommitList {
  /** `<short sha> <subject>`, newest first, at most `MAX_COMMITS`. */
  commits: string[];
  /** How many there are in all. */
  total: number;
}

/**
 * The commits from `from` (exclusive) to `to` along `to`'s first parents, so a merge of the base
 * branch counts once rather than with every commit it brought in; `null` when `from` isn't an
 * ancestor of `to` (a force-push).
 */
export async function commitsBetween(
  cwd: string,
  from: string,
  to: string,
): Promise<CommitList | null> {
  const { code } = await git(cwd, ["merge-base", "--is-ancestor", from, to], {
    okCodes: [0, 1, 128],
  });
  if (code !== 0) return null;
  const range = `${from}..${to}`;
  const [log, count] = await Promise.all([
    git(cwd, ["log", "--first-parent", `--max-count=${MAX_COMMITS}`, "--format=%h %s", range]),
    git(cwd, ["rev-list", "--first-parent", "--count", range]),
  ]);
  return {
    commits: log.stdout.split("\n").filter((line) => line !== ""),
    total: Number(count.stdout.trim()),
  };
}

/** A commit a stored PR pins. */
export interface PrPin {
  number: number;
  sha: string;
}

export function pinRef({ number, sha }: PrPin): string {
  return `${PR_REFS_PREFIX}${number}/${sha}`;
}

/**
 * Makes `refs/pi-code/pr/` of the repository at `gitDir` hold exactly `pins`: deletes the refs
 * nothing pins and creates the missing ones whose commit is present. A repository that is gone
 * is skipped. Every change is attempted; throws afterwards when any failed.
 */
export async function syncPrRefs(gitDir: string, pins: Iterable<PrPin>): Promise<void> {
  if (!existsSync(gitDir)) return;
  const wanted = new Map([...pins].map((pin) => [pinRef(pin), pin.sha]));
  const { stdout } = await runGit(gitDir, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    PR_REFS_PREFIX,
  ]);
  const existing = new Map(
    stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.split(" ") as [string, string]),
  );
  const failures: string[] = [];
  const updateRef = async (args: string[]) => {
    try {
      await runGit(gitDir, ["update-ref", ...args]);
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      failures.push(`git update-ref ${args.join(" ")}: ${e.stderr.trim() || e.message}`);
    }
  };
  for (const [ref, sha] of existing) {
    if (wanted.get(ref) !== sha) await updateRef(["-d", ref]);
  }
  for (const [ref, sha] of wanted) {
    if (existing.get(ref) !== sha && (await hasCommit(gitDir, sha))) await updateRef([ref, sha]);
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
}
