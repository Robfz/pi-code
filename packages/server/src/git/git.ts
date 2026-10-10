/**
 * Git diff and status for an agent's cwd (design/01-server.md, "Git"), and `runGit`, which runs
 * `git` directly (no shell) with a timeout (10 s by default).
 */
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { GitDiffResponse, GitFileDiff, GitStatus } from "@pi-code/protocol";
import { ApiError } from "../errors.ts";

/** Git's well-known empty tree: the diff base of a repository without commits. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Files larger than this are listed without a patch. */
export const MAX_PATCH_BYTES = 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Concurrent `git diff --no-index` runs for untracked files. */
const UNTRACKED_CONCURRENCY = 8;

export class GitError extends Error {
  override name = "GitError";
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunGitOptions {
  /** Exit codes that resolve (default `[0]`). */
  okCodes?: readonly number[];
  /** Default 10 s. */
  timeoutMs?: number;
  /** Added to the server's environment. */
  env?: Record<string, string>;
  /** Written to stdin, which is otherwise empty. */
  input?: string;
}

/**
 * Runs `git args` in `cwd`. Resolves for exit codes in `okCodes`, rejects with `GitError`
 * otherwise, after `timeoutMs`, or when the output exceeds `MAX_OUTPUT_BYTES`.
 */
export function runGit(
  cwd: string,
  args: readonly string[],
  opts: RunGitOptions = {},
): Promise<GitResult> {
  const okCodes = opts.okCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.quotepath=off", ...args], {
      cwd,
      env: {
        ...process.env,
        ...opts.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        LC_ALL: "C",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A git that exits before reading all of its input fails the write with EPIPE; its exit
    // code tells what happened.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let failure: GitError | undefined;
    const fail = (message: string) => {
      failure ??= new GitError(message, null, "");
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => fail(`git ${args[0]} timed out`),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) fail(`git ${args[0]} output too large`);
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < 64) err.push(chunk);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new GitError(`git failed to start: ${e.message}`, null, ""));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString("utf8");
      if (failure) return reject(failure);
      if (code === null || !okCodes.includes(code)) {
        return reject(
          new GitError(`git ${args[0]} exited with ${code}: ${stderr.trim()}`, code, stderr),
        );
      }
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr });
    });
  });
}

/** The work tree's top-level directory, or `null` when `cwd` isn't inside a git work tree. */
export async function gitTopLevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    const top = stdout.trim();
    return top === "" ? null : top;
  } catch (e) {
    if (e instanceof GitError && e.code !== null) return null; // not a repo (128), bare repo…
    throw e;
  }
}

/** Throws `not_a_git_repo` unless `cwd` is inside a git work tree. */
export async function requireWorkTree(cwd: string): Promise<void> {
  if ((await gitTopLevel(cwd)) === null) {
    throw new ApiError("not_a_git_repo", `${cwd} is not inside a git work tree`);
  }
}

async function hasHead(cwd: string): Promise<boolean> {
  const { code } = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    okCodes: [0, 1, 128],
  });
  return code === 0;
}

/** `{ branch, dirty }`, or `null` outside a git work tree. */
export async function gitStatus(cwd: string): Promise<GitStatus | null> {
  const top = await gitTopLevel(cwd);
  if (top === null) return null;
  let branch: string | null = null;
  const symbolic = await runGit(top, ["symbolic-ref", "--short", "-q", "HEAD"], {
    okCodes: [0, 1, 128],
  });
  if (symbolic.code === 0) branch = symbolic.stdout.trim() || null;
  else if (await hasHead(top)) {
    // Detached HEAD: the short commit id.
    branch = (await runGit(top, ["rev-parse", "--short", "HEAD"])).stdout.trim() || null;
  }
  const status = await runGit(top, ["status", "--porcelain=v1", "-uno"]);
  return { branch, dirty: status.stdout.trim() !== "" };
}

interface ChangedFile {
  status: GitFileDiff["status"];
  path: string;
  oldPath?: string;
}

/** Parses `git diff --name-status -z` output. */
function parseNameStatus(out: string): ChangedFile[] {
  const parts = out.split("\0");
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < parts.length) {
    const code = parts[i++];
    if (!code) continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = parts[i++] ?? "";
      const path = parts[i++] ?? "";
      files.push(letter === "R" ? { status: "renamed", path, oldPath } : { status: "added", path });
      continue;
    }
    const path = parts[i++] ?? "";
    const status = letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
    files.push({ status, path });
  }
  return files;
}

/** Splits a multi-file patch at its `diff --git` headers. */
function splitPatch(patch: string): string[] {
  if (patch === "") return [];
  const chunks: string[] = [];
  let start = 0;
  for (;;) {
    const next = patch.indexOf("\ndiff --git ", start);
    if (next < 0) break;
    chunks.push(patch.slice(start, next + 1));
    start = next + 1;
  }
  chunks.push(patch.slice(start));
  return chunks;
}

function isBinaryPatch(patch: string): boolean {
  return /^(Binary files .* differ|GIT binary patch)$/m.test(patch);
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    const s = await lstat(path);
    return s.isFile() ? s.size : undefined;
  } catch {
    return undefined;
  }
}

/** The `paths` (relative to `cwd`) whose working-tree file is over `MAX_PATCH_BYTES`. */
async function largeFiles(cwd: string, paths: string[]): Promise<string[]> {
  const sizes = await Promise.all(paths.map((path) => fileSize(join(cwd, path))));
  return paths.filter((_, i) => (sizes[i] ?? 0) > MAX_PATCH_BYTES);
}

/**
 * The `paths` (relative to `cwd`) whose blob at `rev` is over `MAX_PATCH_BYTES`, sized by a
 * single git process. Its input is line-based, so a path containing a newline goes unchecked;
 * `toDiff` still bounds its patch.
 */
async function largeBlobs(cwd: string, rev: string, paths: string[]): Promise<string[]> {
  const queried = paths.filter((path) => !path.includes("\n"));
  if (queried.length === 0) return [];
  const { stdout } = await runGit(cwd, ["cat-file", "--batch-check=%(objectsize)"], {
    input: queried.map((path) => `${rev}:./${path}\n`).join(""),
  });
  // One line per input line: the size, or `<object> missing`.
  const sizes = stdout.split("\n");
  return queried.filter((_, i) => Number(sizes[i]) > MAX_PATCH_BYTES);
}

function toDiff(file: ChangedFile, patch: string | undefined, tooLarge: boolean): GitFileDiff {
  const diff: GitFileDiff = { path: file.path, status: file.status, binary: false, tooLarge };
  if (file.oldPath !== undefined) diff.oldPath = file.oldPath;
  if (tooLarge || patch === undefined) return diff;
  if (isBinaryPatch(patch)) diff.binary = true;
  else if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) diff.tooLarge = true;
  else diff.patch = patch;
  return diff;
}

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M", "--relative"] as const;

/**
 * Tracked changes under `cwd` from `from` to `to`, or to the working tree without `to`. Paths
 * are relative to `cwd`; changes outside its subtree are left out.
 */
async function trackedDiffs(cwd: string, from: string, to?: string): Promise<GitFileDiff[]> {
  const revs = to === undefined ? [from] : [from, to];
  const listed = parseNameStatus(
    (await runGit(cwd, ["diff", ...DIFF_FLAGS, "--name-status", "-z", ...revs])).stdout,
  );
  if (listed.length === 0) return [];

  const deleted = listed.filter((f) => f.status === "deleted").map((f) => f.path);
  const present = listed.filter((f) => f.status !== "deleted").map((f) => f.path);
  const large = new Set(
    (
      await Promise.all([
        largeBlobs(cwd, from, deleted),
        to === undefined ? largeFiles(cwd, present) : largeBlobs(cwd, to, present),
      ])
    ).flat(),
  );
  const exclude = [...large].map((path) => `:(exclude,literal)${path}`);
  const patchArgs = ["diff", ...DIFF_FLAGS, "--patch", ...revs, "--", ".", ...exclude];
  const chunks = splitPatch((await runGit(cwd, patchArgs)).stdout);
  const withPatch = listed.filter((f) => !large.has(f.path));

  // Both listings come from the same diff machinery, so their order matches. A count mismatch
  // (e.g. a type change, which the patch shows as delete + add) falls back to per-file diffs.
  if (chunks.length === withPatch.length) {
    let i = 0;
    return listed.map((file) =>
      large.has(file.path) ? toDiff(file, undefined, true) : toDiff(file, chunks[i++], false),
    );
  }
  return Promise.all(
    listed.map(async (file) => {
      if (large.has(file.path)) return toDiff(file, undefined, true);
      const paths = file.oldPath === undefined ? [file.path] : [file.oldPath, file.path];
      const { stdout } = await runGit(cwd, [
        "--literal-pathspecs",
        "diff",
        ...DIFF_FLAGS,
        "--patch",
        ...revs,
        "--",
        ...paths,
      ]);
      return toDiff(file, stdout, false);
    }),
  );
}

async function untrackedDiff(cwd: string, path: string): Promise<GitFileDiff> {
  const file: ChangedFile = { status: "untracked", path };
  if (path.endsWith("/")) {
    // A nested repository: listed, never diffed.
    return toDiff({ ...file, path: path.slice(0, -1) }, undefined, false);
  }
  const size = await fileSize(join(cwd, path));
  if (size !== undefined && size > MAX_PATCH_BYTES) return toDiff(file, undefined, true);
  // Exit code 1 means "differences found", the normal outcome here.
  const { stdout } = await runGit(
    cwd,
    ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", path],
    { okCodes: [0, 1] },
  );
  return toDiff(file, stdout, false);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Untracked, non-ignored files under `cwd` as new-file patches, paths relative to `cwd`. */
async function untrackedDiffs(cwd: string): Promise<GitFileDiff[]> {
  const { stdout } = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = stdout.split("\0").filter((p) => p !== "");
  return mapLimit(paths, UNTRACKED_CONCURRENCY, (p) => untrackedDiff(cwd, p));
}

async function shortRev(cwd: string, rev: string): Promise<string> {
  // Plain `--short` follows core.abbrev, which may be as low as 4.
  return (await runGit(cwd, ["rev-parse", "--short=7", rev])).stdout.trim();
}

/** The merge-base of local branch `base` and `HEAD`; throws `invalid_body` when there is none. */
async function mergeBase(cwd: string, base: string): Promise<string> {
  // `show-ref --verify` takes only a full ref name, so expressions like `main~1` are rejected.
  const ref = `refs/heads/${base}`;
  const exists =
    !base.startsWith("-") &&
    (await runGit(cwd, ["show-ref", "--verify", "--quiet", ref], { okCodes: [0, 1] })).code === 0;
  if (!exists) throw new ApiError("invalid_body", `unknown branch ${base}`);
  const { code, stdout } = await runGit(cwd, ["merge-base", ref, "HEAD"], { okCodes: [0, 1] });
  if (code === 1) throw new ApiError("invalid_body", `${base} and HEAD have no common commit`);
  return stdout.trim();
}

/** Paths under `cwd` whose working-tree copy differs from `HEAD`. */
async function worktreeChangedPaths(cwd: string): Promise<Set<string>> {
  const { stdout } = await runGit(cwd, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--relative",
    "HEAD",
  ]);
  return new Set(stdout.split("\0").filter((p) => p !== ""));
}

export interface GitDiffOptions {
  /** Local branch to diff against, from its merge-base with `HEAD` (branch mode). */
  base?: string;
  /** Branch mode: diff the merge-base against the working tree, untracked files included. */
  uncommitted?: boolean;
}

/**
 * The changes under `cwd` (design/07-code-review.md, "Diff modes"), paths relative to `cwd`.
 * Without `base`: tracked files against `HEAD` (the empty tree without commits), plus untracked
 * files as new-file patches. With `base`: from its merge-base with `HEAD` to the working tree
 * plus untracked files (`uncommitted`), or to `HEAD`. Throws `not_a_git_repo` outside a work
 * tree and `invalid_body` for an unusable `base`.
 */
export async function gitDiff(cwd: string, opts: GitDiffOptions = {}): Promise<GitDiffResponse> {
  await requireWorkTree(cwd);
  const committed = await hasHead(cwd);
  if (opts.base === undefined) {
    const [tracked, untracked, oldRev] = await Promise.all([
      trackedDiffs(cwd, committed ? "HEAD" : EMPTY_TREE),
      untrackedDiffs(cwd),
      committed ? shortRev(cwd, "HEAD") : undefined,
    ]);
    const files = [...tracked, ...untracked];
    return oldRev === undefined ? { files } : { files, oldRev };
  }

  if (!committed) throw new ApiError("invalid_body", "no commits yet");
  const base = await mergeBase(cwd, opts.base);
  const oldRev = await shortRev(cwd, base);
  if (opts.uncommitted) {
    const [tracked, untracked] = await Promise.all([trackedDiffs(cwd, base), untrackedDiffs(cwd)]);
    return { files: [...tracked, ...untracked], oldRev };
  }
  const [files, changed, newRev] = await Promise.all([
    trackedDiffs(cwd, base, "HEAD"),
    worktreeChangedPaths(cwd),
    shortRev(cwd, "HEAD"),
  ]);
  for (const file of files) if (changed.has(file.path)) file.worktreeChanged = true;
  return { files, oldRev, newRev };
}
