/**
 * Git diff and status for an agent's cwd (design/01-server.md, "Git"). Runs `git` directly
 * (no shell) with a 10 s timeout.
 */
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { GitFileDiff, GitStatus } from "@pi-code/protocol";
import { ApiError } from "../errors.ts";

/** Git's well-known empty tree: the diff base of a repository without commits. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Files larger than this are listed without a patch. */
export const MAX_PATCH_BYTES = 1024 * 1024;

const GIT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Concurrent `git diff --no-index` runs for untracked files. */
const UNTRACKED_CONCURRENCY = 8;

class GitError extends Error {
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

/**
 * Runs `git args` in `cwd`. Resolves for exit codes in `okCodes` (default `[0]`), rejects with
 * `GitError` otherwise, on timeout, or when the output exceeds `MAX_OUTPUT_BYTES`.
 */
function runGit(
  cwd: string,
  args: readonly string[],
  opts: { okCodes?: readonly number[] } = {},
): Promise<GitResult> {
  const okCodes = opts.okCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.quotepath=off", ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        LC_ALL: "C",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let failure: GitError | undefined;
    const fail = (message: string) => {
      failure ??= new GitError(message, null, "");
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => fail(`git ${args[0]} timed out`), GIT_TIMEOUT_MS);
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
async function gitTopLevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    const top = stdout.trim();
    return top === "" ? null : top;
  } catch (e) {
    if (e instanceof GitError && e.code !== null) return null; // not a repo (128), bare repo…
    throw e;
  }
}

async function hasHead(top: string): Promise<boolean> {
  const { code } = await runGit(top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
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

/** Size of `<rev>:<path>` in the object store (for deleted files). */
async function blobSize(top: string, rev: string, path: string): Promise<number | undefined> {
  try {
    const { stdout } = await runGit(top, ["cat-file", "-s", `${rev}:${path}`]);
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
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

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"] as const;

async function trackedDiffs(top: string, base: string): Promise<GitFileDiff[]> {
  const listed = parseNameStatus(
    (await runGit(top, ["diff", ...DIFF_FLAGS, "--name-status", "-z", base])).stdout,
  );
  if (listed.length === 0) return [];

  const large = new Set<string>();
  await Promise.all(
    listed.map(async (file) => {
      const size =
        file.status === "deleted"
          ? await blobSize(top, base, file.path)
          : await fileSize(join(top, file.path));
      if (size !== undefined && size > MAX_PATCH_BYTES) large.add(file.path);
    }),
  );
  const exclude = [...large].map((path) => `:(exclude,literal)${path}`);
  const patchArgs = ["diff", ...DIFF_FLAGS, "--patch", base, "--", ".", ...exclude];
  const chunks = splitPatch((await runGit(top, patchArgs)).stdout);
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
      const { stdout } = await runGit(top, [
        "--literal-pathspecs",
        "diff",
        ...DIFF_FLAGS,
        "--patch",
        base,
        "--",
        ...paths,
      ]);
      return toDiff(file, stdout, false);
    }),
  );
}

async function untrackedDiff(top: string, path: string): Promise<GitFileDiff> {
  const file: ChangedFile = { status: "untracked", path };
  if (path.endsWith("/")) {
    // A nested repository: listed, never diffed.
    return toDiff({ ...file, path: path.slice(0, -1) }, undefined, false);
  }
  const size = await fileSize(join(top, path));
  if (size !== undefined && size > MAX_PATCH_BYTES) return toDiff(file, undefined, true);
  // Exit code 1 means "differences found", the normal outcome here.
  const { stdout } = await runGit(
    top,
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

/**
 * The working tree's changes: tracked files against `HEAD` (the empty tree without commits),
 * plus untracked files as new-file patches. Throws `not_a_git_repo` outside a work tree.
 */
export async function gitDiff(cwd: string): Promise<GitFileDiff[]> {
  const top = await gitTopLevel(cwd);
  if (top === null) throw new ApiError("not_a_git_repo", `${cwd} is not inside a git work tree`);
  const base = (await hasHead(top)) ? "HEAD" : EMPTY_TREE;
  const [tracked, untrackedOut] = await Promise.all([
    trackedDiffs(top, base),
    runGit(top, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const untrackedPaths = untrackedOut.stdout.split("\0").filter((p) => p !== "");
  const untracked = await mapLimit(untrackedPaths, UNTRACKED_CONCURRENCY, (p) =>
    untrackedDiff(top, p),
  );
  return [...tracked, ...untracked];
}
