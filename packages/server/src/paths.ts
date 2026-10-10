import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ApiError } from "./errors.ts";

/** Whether `path` is `dir` or below it (both absolute, already resolved). */
export function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** pi's `canonicalizePath`: the realpath, or the path itself when it can't be resolved. */
export async function canonicalize(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

/**
 * `path`'s realpath, or for a missing path the realpath of its nearest existing ancestor plus
 * the rest.
 */
export async function realpathOrAncestor(path: string): Promise<string> {
  const suffix: string[] = [];
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    try {
      return join(await realpath(dir), ...suffix);
    } catch {
      if (dirname(dir) === dir) return resolve(path);
      suffix.unshift(basename(dir));
    }
  }
}

/** `realpathOrAncestor(path)`; `outside_home` unless inside `realpath(home)`. */
export async function canonicalPath(path: string, home: string): Promise<string> {
  const realHome = await realpath(home);
  const canonical = await realpathOrAncestor(path);
  if (!isInside(realHome, canonical)) {
    throw new ApiError("outside_home", `${path} must be inside ${realHome}`);
  }
  return canonical;
}
