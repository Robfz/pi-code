/**
 * The branch of each folder with a live agent, from git's files rather than `git` runs
 * (design/05-desktop.md, "Folder branches").
 */
import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The git dir of the work tree containing `cwd`: the first `.git` walking up, itself when a
 * directory, else the `gitdir:` it points to (worktrees, submodules), relative to its own
 * directory. `undefined` outside a work tree, or when the walk hits an I/O error.
 */
export function findGitDir(cwd: string): string | undefined {
  try {
    for (let dir = cwd; ; dir = dirname(dir)) {
      const dotGit = join(dir, ".git");
      const stat = statSync(dotGit, { throwIfNoEntry: false });
      if (stat?.isDirectory()) return dotGit;
      if (stat?.isFile()) {
        const target = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
        return target === undefined ? undefined : resolve(dir, target);
      }
      if (dirname(dir) === dir) return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * The branch `<gitDir>/HEAD` names (`ref: refs/heads/x` → `x`, another ref as is), or the first
 * 7 characters of a detached commit id. `undefined` when unreadable or unrecognized.
 */
export function readHead(gitDir: string): string | undefined {
  let head: string;
  try {
    head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return undefined;
  }
  if (head.startsWith("ref:")) {
    const ref = head.slice("ref:".length).trim();
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    return branch || undefined;
  }
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head) ? head.slice(0, 7) : undefined;
}

interface Tracked {
  gitDir: string;
  watcher: FSWatcher | undefined;
  /** Last reported branch; `undefined` until `HEAD` was read. */
  branch: string | undefined;
}

/**
 * Tracks the branch of a set of folders: resolves each one's git dir once, watches that dir
 * non-recursively (a directory watch survives git replacing `HEAD` by rename), re-reads `HEAD`
 * on every event and reports changes through `onChange`; `null` when a folder stops being
 * tracked.
 */
export class FolderBranches {
  private readonly onChange: (cwd: string, branch: string | null) => void;
  /** Tracked folders; `null` for those outside a git work tree. */
  private readonly tracked = new Map<string, Tracked | null>();

  constructor(onChange: (cwd: string, branch: string | null) => void) {
    this.onChange = onChange;
  }

  /** cwd → branch of the tracked folders whose `HEAD` is known. */
  current(): Record<string, string> {
    const branches: Record<string, string> = {};
    for (const [cwd, t] of this.tracked) if (t?.branch !== undefined) branches[cwd] = t.branch;
    return branches;
  }

  /** Tracks exactly `cwds`: starts the new ones, stops the others. */
  sync(cwds: ReadonlySet<string>): void {
    for (const [cwd, t] of this.tracked) {
      if (cwds.has(cwd)) continue;
      this.tracked.delete(cwd);
      if (t === null) continue;
      t.watcher?.close();
      if (t.branch !== undefined) this.onChange(cwd, null);
    }
    for (const cwd of cwds) if (!this.tracked.has(cwd)) this.start(cwd);
  }

  /** Stops every watch, reporting nothing. */
  close(): void {
    for (const t of this.tracked.values()) t?.watcher?.close();
    this.tracked.clear();
  }

  private start(cwd: string): void {
    const gitDir = findGitDir(cwd);
    if (gitDir === undefined) {
      this.tracked.set(cwd, null);
      return;
    }
    const t: Tracked = { gitDir, watcher: undefined, branch: undefined };
    this.tracked.set(cwd, t);
    // Started before the first read, so later changes are picked up once the watch is running.
    try {
      t.watcher = watch(gitDir, () => this.refresh(cwd, t));
      t.watcher.on("error", (e) => console.warn(`[git] watch of ${gitDir}: ${e.message}`));
    } catch (e) {
      console.warn(`[git] not watching ${gitDir}: ${(e as Error).message}`);
    }
    this.refresh(cwd, t);
  }

  private refresh(cwd: string, t: Tracked): void {
    if (this.tracked.get(cwd) !== t) return; // an event queued before the watch stopped
    const branch = readHead(t.gitDir);
    if (branch === undefined || branch === t.branch) return;
    t.branch = branch;
    this.onChange(cwd, branch);
  }
}
