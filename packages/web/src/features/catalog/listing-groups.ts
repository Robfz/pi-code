/**
 * The grouping shared by every listing surface (`docs/design/06-worktrees.md`, "Grouping model"):
 * folder groups by cwd, and one repo group per `<repo>/main` layout with its container items and
 * a sub-group per checkout.
 */

import type { AgentInfo, RepoLayout, SessionSummary } from "@pi-code/protocol";
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

export type ListingGroup<T> =
  | { kind: "folder"; cwd: string; label: string; items: T[] }
  | {
      kind: "repo";
      /** The container folder. */
      repo: string;
      label: string;
      /** The container's own items. */
      items: T[];
      /** The main checkout first, then the others by most recent item. */
      worktrees: WorktreeGroup<T>[];
    };

export interface ListingKeys<T> {
  cwd(item: T): string;
  layout(item: T): RepoLayout | undefined;
  /** Epoch ms. */
  activity(item: T): number;
}

/** Epoch ms of an ISO time; 0 when absent or unparsable. */
export function epochMs(iso: string | undefined): number {
  const ms = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
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
  sessionsByFile: ReadonlyMap<string, SessionSummary>,
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
 * Groups ordered by their most recent item, items by activity. Top-level labels are the folder
 * basename, with the parent's basename prepended when another top-level group shares it.
 */
export function groupListing<T>(items: readonly T[], keys: ListingKeys<T>): ListingGroup<T>[] {
  const groups = new Map<string, ListingGroup<T>>();
  const repos = new Map<
    string,
    { group: Extract<ListingGroup<T>, { kind: "repo" }>; checkouts: Map<string, WorktreeGroup<T>> }
  >();
  const sorted = [...items].sort((a, b) => keys.activity(b) - keys.activity(a));
  // Map insertion order follows the items' order: groups and checkouts come most recent first.
  for (const item of sorted) {
    const cwd = keys.cwd(item);
    const layout = keys.layout(item);
    if (layout === undefined) {
      const key = `folder:${cwd}`;
      const group = groups.get(key);
      if (group) group.items.push(item);
      else groups.set(key, { kind: "folder", cwd, label: "", items: [item] });
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
  for (const { group, checkouts } of repos.values()) {
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
