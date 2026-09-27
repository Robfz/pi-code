import { isAbsolute, relative, sep } from "node:path";

/** Whether `path` is `dir` or below it (both absolute, already resolved). */
export function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
