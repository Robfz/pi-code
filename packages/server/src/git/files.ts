/**
 * File search and file reads in an agent's cwd (design/07-code-review.md, "GET files" and
 * "GET files/content").
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { FileContentResponse } from "@pi-code/protocol";
import fuzzysort from "fuzzysort";
import { ApiError } from "../errors.ts";
import { gitTopLevel, MAX_PATCH_BYTES, runGit } from "./git.ts";

const MAX_QUERY_LENGTH = 200;
const SEARCH_LIMIT = 10;
/** Git's binary heuristic: a NUL byte within the first 8000 bytes. */
const BINARY_SNIFF_BYTES = 8000;

async function requireWorkTree(cwd: string): Promise<void> {
  if ((await gitTopLevel(cwd)) === null) {
    throw new ApiError("not_a_git_repo", `${cwd} is not inside a git work tree`);
  }
}

/**
 * Tracked and untracked non-ignored files under `cwd`, relative to it, without nested
 * repositories. `cwd` must be inside a git work tree.
 */
export async function listProjectFiles(cwd: string): Promise<string[]> {
  const { stdout } = await runGit(cwd, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  // Unmerged files are listed once per stage; nested repositories are listed as `dir/`.
  const paths = new Set(stdout.split("\0").filter((p) => p !== "" && !p.endsWith("/")));
  return [...paths];
}

/**
 * The project files best matching `q`, at most 10. A file whose basename matches ranks above
 * every file matched only across directories. Throws `invalid_body` for a query over 200
 * characters and `not_a_git_repo` outside a work tree.
 */
export async function searchFiles(cwd: string, q: string): Promise<string[]> {
  const query = q.trim();
  if (query.length > MAX_QUERY_LENGTH) {
    throw new ApiError("invalid_body", `q must be at most ${MAX_QUERY_LENGTH} characters`);
  }
  await requireWorkTree(cwd);
  if (query === "") return [];
  const targets = (await listProjectFiles(cwd)).map((path) => ({ path, name: basename(path) }));
  const results = fuzzysort.go(query, targets, {
    keys: ["path", "name"],
    limit: SEARCH_LIMIT,
    threshold: 0,
    // Scores are 0–1 and an unmatched key scores 0, so any basename match lands above 1.
    scoreFn: (r) => {
      const name = r[1]?.score ?? 0;
      return name > 0 ? 1 + name : (r[0]?.score ?? 0);
    },
  });
  return results.map((r) => r.obj.path);
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel.split(sep)[0] !== ".." && !isAbsolute(rel);
}

function outside(path: string): ApiError {
  return new ApiError("invalid_body", `${path} is outside the project`);
}

function notFound(path: string): ApiError {
  return new ApiError("file_not_found", `${path} does not exist`);
}

/**
 * The working-tree copy of `path` (relative to `cwd`, or absolute), confined to `cwd` by
 * realpath, so `..` and symlinks leading out are rejected with `invalid_body`. Missing files
 * and non-files throw `file_not_found`; outside a work tree, `not_a_git_repo`.
 */
export async function readProjectFile(cwd: string, path: string): Promise<FileContentResponse> {
  await requireWorkTree(cwd);
  const root = await realpath(cwd);
  const target = resolve(root, path);
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw isInside(root, target) ? notFound(path) : outside(path);
  }
  if (real === root) throw notFound(path);
  if (!isInside(root, real)) throw outside(path);

  const info = await stat(real);
  if (!info.isFile()) throw notFound(path);
  const response: FileContentResponse = {
    path: relative(root, real),
    binary: false,
    tooLarge: false,
  };
  if (info.size > MAX_PATCH_BYTES) return { ...response, tooLarge: true };

  const bytes = await readFile(real);
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { ...response, binary: true };
  return { ...response, content: bytes.toString("utf8") };
}
