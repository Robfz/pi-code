/**
 * Directory autocomplete under `$HOME` (`GET /api/fs/dirs`).
 */
import { type Dirent, existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { DirSuggestion } from "@pi-code/protocol";
import { ApiError } from "../errors.ts";
import { isInside } from "../paths.ts";

export const MAX_DIR_SUGGESTIONS = 50;

interface ListDirsOptions {
  /** `$HOME` (confinement root; `~` expands to it). */
  home: string;
  /** Header cwds that have pi sessions. */
  sessionCwds: () => Promise<Set<string>>;
}

/**
 * Splits a typed prefix into the directory to list and the partial name to match:
 * `~/De` → (`$HOME`, `De`); `~/Dev/` → (`$HOME/Dev`, ``); `~` → (`$HOME`, ``).
 */
export function splitPrefix(prefix: string, home: string): { dir: string; partial: string } {
  let expanded: string;
  if (prefix === "" || prefix === "~" || prefix === "~/") expanded = `${home}/`;
  // Plain concatenation: the last segment is typed text (`.`, `..`), not a path to normalize.
  else if (prefix.startsWith("~/")) expanded = `${home.replace(/\/$/, "")}/${prefix.slice(2)}`;
  else if (isAbsolute(prefix)) expanded = prefix;
  else throw new ApiError("invalid_body", "prefix must be absolute or start with ~");
  const slash = expanded.lastIndexOf("/");
  const dir = resolve(expanded.slice(0, slash + 1) || "/");
  return { dir, partial: expanded.slice(slash + 1) };
}

/**
 * Lists directories whose name starts with the typed partial (case-insensitive), in the typed
 * parent directory. The parent must resolve (realpath) inside `$HOME`, else `outside_home`;
 * symlinked children resolving outside `$HOME` are dropped. Dot-directories appear only when the
 * partial starts with `.`. At most `MAX_DIR_SUGGESTIONS`, sorted by name.
 */
export async function listDirs(prefix: string, opts: ListDirsOptions): Promise<DirSuggestion[]> {
  const home = await realpath(opts.home);
  const { dir, partial } = splitPrefix(prefix, opts.home);
  const outside = () => new ApiError("outside_home", `prefix must be inside ${home}`);
  if (!isInside(opts.home, dir) && !isInside(home, dir)) throw outside();
  let dirReal: string;
  try {
    dirReal = await realpath(dir);
  } catch {
    return [];
  }
  if (!isInside(home, dirReal)) throw outside();

  let entries: Dirent[];
  try {
    entries = await readdir(dirReal, { withFileTypes: true });
  } catch {
    return [];
  }
  const showDot = partial.startsWith(".");
  const needle = partial.toLowerCase();
  const candidates = entries
    .filter((e) => (showDot || !e.name.startsWith(".")) && e.name.toLowerCase().startsWith(needle))
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

  const cwds = await opts.sessionCwds();
  const out: DirSuggestion[] = [];
  for (const e of candidates) {
    if (out.length >= MAX_DIR_SUGGESTIONS) break;
    const path = join(dirReal, e.name);
    let real = path;
    if (e.isSymbolicLink()) {
      try {
        real = await realpath(path);
        if (!isInside(home, real) || !(await stat(real)).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    out.push({
      path,
      isGitRepo: existsSync(join(real, ".git")),
      hasSessions: cwds.has(path) || cwds.has(real),
    });
  }
  return out;
}
