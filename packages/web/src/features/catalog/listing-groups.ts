/**
 * The grouping shared by every listing surface (`docs/design/06-worktrees.md`, "Grouping model"):
 * folder groups by cwd, and one repo group per `<repo>/main` layout with its container items and
 * a sub-group per checkout.
 */

import {
  type AgentInfo,
  compareRecency,
  type Recency,
  type RepoLayout,
  recencyOf,
  type StreamedSession,
} from "@pi-code/protocol";
import { baseName } from "@/lib/content";

export interface WorktreeGroup<T> {
  cwd: string;
  /** Folder basename. */
  label: string;
  role: "main" | "worktree";
  /** Some item's layout says the folder is gone. */
  missing: boolean;
  items: T[];
}

export interface RepoGroup<T> {
  kind: "repo";
  /** The container folder. */
  repo: string;
  label: string;
  /** The container's own items. */
  items: T[];
  /** The main checkout first, then the others by their first item (`compareRecency`). */
  worktrees: WorktreeGroup<T>[];
}

export interface FolderGroup<T> {
  kind: "folder";
  cwd: string;
  label: string;
  /** Some item says the folder is gone (`ListingKeys.missing`). */
  missing: boolean;
  items: T[];
}

export type ListingGroup<T> = FolderGroup<T> | RepoGroup<T>;

export interface ListingKeys<T> {
  cwd(item: T): string;
  layout(item: T): RepoLayout | undefined;
  recency(item: T): Recency;
  /** The item's folder is gone; read outside a layout (checkouts use `layout.missing`). */
  missing?(item: T): boolean;
}

/**
 * An agent's recency: its session's, or, before its session file is listed, its start (a
 * conversation without a file has no prompt yet).
 */
export function agentRecency(agent: AgentInfo, session: StreamedSession | undefined): Recency {
  return session === undefined ? recencyOf({ createdAt: agent.startedAt }) : recencyOf(session);
}

function parentName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return baseName(trimmed.slice(0, trimmed.lastIndexOf("/")) || "/");
}

/**
 * An agent's layout: its session's from the latest scan, which knows when the folder went
 * missing, else the one from when it was opened.
 */
export function agentLayout(
  agent: AgentInfo,
  sessionsByFile: ReadonlyMap<string, StreamedSession>,
): RepoLayout | undefined {
  return (
    (agent.sessionFile ? sessionsByFile.get(agent.sessionFile)?.layout : undefined) ?? agent.layout
  );
}

/** A group's path: the container for repo groups. */
export function groupPath(group: ListingGroup<unknown>): string {
  return group.kind === "folder" ? group.cwd : group.repo;
}

/**
 * Items ordered by `compareRecency`, groups by their first item, so groups with a prompt come
 * before those without. `repos` adds a repo group, after the others, for each container path
 * that has no items. With `mains` set, every repo group has its main checkout's sub-group, empty
 * when no item sits there, once the main path is known: from an item's layout, else from `mains`
 * (container path → main checkout). Top-level labels are the folder basename, with the parent's
 * basename prepended when another top-level group shares it.
 */
export function groupListing<T>(
  items: readonly T[],
  keys: ListingKeys<T>,
  {
    repos: emptyRepos = [],
    mains,
  }: { repos?: readonly string[]; mains?: Readonly<Record<string, string>> } = {},
): ListingGroup<T>[] {
  const groups = new Map<string, ListingGroup<T>>();
  const repos = new Map<
    string,
    { group: RepoGroup<T>; checkouts: Map<string, WorktreeGroup<T>>; main?: string }
  >();
  const sorted = [...items].sort((a, b) => compareRecency(keys.recency(a), keys.recency(b)));
  // Map insertion order follows the items' order: groups and checkouts come in item order.
  for (const item of sorted) {
    const cwd = keys.cwd(item);
    const layout = keys.layout(item);
    if (layout === undefined) {
      const key = `folder:${cwd}`;
      const missing = keys.missing?.(item) === true;
      const group = groups.get(key);
      if (group?.kind === "folder") {
        group.items.push(item);
        if (missing) group.missing = true;
      } else {
        groups.set(key, { kind: "folder", cwd, label: "", missing, items: [item] });
      }
      continue;
    }
    let repo = repos.get(layout.repo);
    if (repo === undefined) {
      repo = {
        group: { kind: "repo", repo: layout.repo, label: "", items: [], worktrees: [] },
        checkouts: new Map(),
      };
      repos.set(layout.repo, repo);
      groups.set(`repo:${layout.repo}`, repo.group);
    }
    repo.main ??= layout.main;
    if (layout.role === "container") {
      repo.group.items.push(item);
      continue;
    }
    const worktree = repo.checkouts.get(cwd);
    if (worktree) {
      worktree.items.push(item);
      if (layout.missing) worktree.missing = true;
    } else {
      repo.checkouts.set(cwd, {
        cwd,
        label: baseName(cwd),
        role: layout.role,
        missing: layout.missing === true,
        items: [item],
      });
    }
  }
  for (const repo of emptyRepos) {
    if (repos.has(repo)) continue;
    const group: RepoGroup<T> = { kind: "repo", repo, label: "", items: [], worktrees: [] };
    repos.set(repo, { group, checkouts: new Map() });
    groups.set(`repo:${repo}`, group);
  }
  for (const { group, checkouts, main: itemsMain } of repos.values()) {
    const main = itemsMain ?? mains?.[group.repo];
    if (mains !== undefined && main !== undefined && !checkouts.has(main)) {
      checkouts.set(main, {
        cwd: main,
        label: baseName(main),
        role: "main",
        missing: false,
        items: [],
      });
    }
    // Stable sort: the main checkout moves first, the rest keep their recency order.
    group.worktrees = [...checkouts.values()].sort(
      (a, b) => Number(b.role === "main") - Number(a.role === "main"),
    );
  }

  const all = [...groups.values()];
  const basenameCount = new Map<string, number>();
  for (const group of all) {
    const name = baseName(groupPath(group));
    basenameCount.set(name, (basenameCount.get(name) ?? 0) + 1);
  }
  return all.map((group) => {
    const path = groupPath(group);
    const name = baseName(path);
    const label = (basenameCount.get(name) ?? 0) > 1 ? `${parentName(path)}/${name}` : name;
    return { ...group, label };
  });
}
