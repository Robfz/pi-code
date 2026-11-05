/**
 * File search and file reads in an agent's cwd (design/07-code-review.md, "GET files" and
 * "GET files/content").
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { FileContentResponse } from "@pi-code/protocol";
import fuzzysort from "fuzzysort";
import { ApiError } from "../errors.ts";
import { isInside, realpathOrAncestor } from "../paths.ts";
import { hasCommit, MAX_PATCH_BYTES, requireWorkTree, runGit } from "./git.ts";

const MAX_QUERY_LENGTH = 200;
const SEARCH_LIMIT = 10;
/** Git's binary heuristic: a NUL byte within the first 8000 bytes. */
const BINARY_SNIFF_BYTES = 8000;

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
  // Prepared here: `go` would keep the strings it prepares in a module-level cache that never
  // shrinks.
  const targets = (await listProjectFiles(cwd)).map((path) => ({
    path: fuzzysort.prepare(path),
    name: fuzzysort.prepare(basename(path)),
  }));
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
  return results.map((r) => r.obj.path.target);
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
  // A missing path is confined by its nearest existing ancestor's realpath: below a link
  // leading out, missing and existing files alike are outside the project.
  const real = await realpathOrAncestor(resolve(root, path));
  if (!isInside(root, real)) throw outside(path);
  const info = await stat(real).catch(() => undefined);
  if (!info?.isFile()) throw notFound(path);
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

/** A commit id as references write it (`git rev-parse --short` output up to a full sha). */
const REV = /^[0-9a-f]{7,40}$/;

/**
 * `path` (relative to `cwd`, or absolute inside it) as committed in `rev`, read from the object
 * database, so the commit needn't be checked out. `rev` must be a commit id and `path` must stay
 * inside `cwd`, else `invalid_body`; a commit or file that doesn't exist, or a path that isn't a
 * file there, throws `file_not_found`; outside a work tree, `not_a_git_repo`.
 */
export async function readFileAtRev(
  cwd: string,
  path: string,
  rev: string,
): Promise<FileContentResponse> {
  if (!REV.test(rev)) {
    throw new ApiError(
      "invalid_body",
      "rev must be a commit id (7 to 40 lowercase hex characters)",
    );
  }
  await requireWorkTree(cwd);
  // The file needn't exist on disk, so it is confined by its path alone, against the cwd as
  // given and as its realpath (an absolute path may use either).
  const roots = [resolve(cwd), await realpath(cwd)];
  const target = isAbsolute(path) ? resolve(path) : resolve(roots[1] as string, path);
  const root = roots.find((dir) => isInside(dir, target));
  if (root === undefined) throw outside(path);
  const rel = relative(root, target);
  if (!(await hasCommit(cwd, rev))) throw new ApiError("file_not_found", `no commit ${rev}`);
  const spec = `${rev}:./${rel}`;
  const type = await runGit(cwd, ["cat-file", "-t", spec], { okCodes: [0, 128] });
  if (type.code !== 0 || type.stdout.trim() !== "blob") {
    throw new ApiError("file_not_found", `${path} does not exist in ${rev}`);
  }
  const response: FileContentResponse = { path: rel, rev, binary: false, tooLarge: false };
  const size = Number((await runGit(cwd, ["cat-file", "-s", spec])).stdout.trim());
  if (size > MAX_PATCH_BYTES) return { ...response, tooLarge: true };
  const { stdout } = await runGit(cwd, ["cat-file", "blob", spec]);
  if (stdout.slice(0, BINARY_SNIFF_BYTES).includes("\0")) return { ...response, binary: true };
  return { ...response, content: stdout };
}
