/**
 * Display model for the session tree screen, built from the store's transcript (which holds
 * every branch) and its labels: entries reduced to user / assistant messages plus compaction
 * and branch-summary markers. Tool traffic (tool-only assistant turns, tool results) and state
 * entries are hidden; their children attach to the nearest shown ancestor. Linear chains stay
 * at one depth; each branch point indents its children.
 */

import { type SessionEntry, splitFileBlocks } from "@pi-code/protocol";
import { baseName, contentText } from "@/lib/content";
import { formatTokens } from "@/lib/time";

export type TreeRowKind = "user" | "assistant" | "compaction" | "branch_summary";

export interface TreeItem {
  id: string;
  kind: TreeRowKind;
  text: string;
  label?: string;
  timestamp: string;
  /** Shown children, in order. */
  children: string[];
}

export interface TreeModel {
  items: Map<string, TreeItem>;
  roots: string[];
  /** Shown entry standing for the current leaf (the leaf or its nearest shown ancestor). */
  currentId: string | null;
  /** Shown entries on the path from the root to the current leaf. */
  activePath: Set<string>;
}

/** A user message's typed text, else its attached file names, else "(image)". */
function userText(text: string): string {
  const { files, body } = splitFileBlocks(text);
  if (body.trim() !== "") return body.trim();
  if (files.length > 0) return `(file: ${files.map((f) => baseName(f.name)).join(", ")})`;
  return "(image)";
}

function describe(entry: SessionEntry): { kind: TreeRowKind; text: string } | null {
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      if (message.role === "user") {
        return { kind: "user", text: userText(contentText(message.content)) };
      }
      if (message.role === "assistant") {
        const text = contentText(message.content).trim();
        if (text !== "") return { kind: "assistant", text };
        if (message.errorMessage)
          return { kind: "assistant", text: `Error: ${message.errorMessage}` };
        if (message.stopReason === "aborted") return { kind: "assistant", text: "Stopped" };
        return null;
      }
      return null;
    }
    case "compaction":
      return {
        kind: "compaction",
        text: `Context compacted (${formatTokens(entry.tokensBefore)} tokens)`,
      };
    case "branch_summary":
      return { kind: "branch_summary", text: "Branch summary" };
    default:
      return null;
  }
}

/**
 * `entries` in session order (children keep that order); `labels` by target entry id. Entries
 * whose parent is missing become roots.
 */
export function buildTreeModel(
  entries: readonly SessionEntry[],
  leafId: string | null,
  labels: ReadonlyMap<string, string> = new Map(),
): TreeModel {
  const byId = new Map<string, SessionEntry>();
  const childrenOf = new Map<string | null, SessionEntry[]>();
  for (const entry of entries) byId.set(entry.id, entry);
  for (const entry of entries) {
    const parent = entry.parentId !== null && byId.has(entry.parentId) ? entry.parentId : null;
    const siblings = childrenOf.get(parent);
    if (siblings) siblings.push(entry);
    else childrenOf.set(parent, [entry]);
  }

  const items = new Map<string, TreeItem>();
  const roots: string[] = [];
  /** Nearest shown ancestor-or-self per entry. */
  const shownFor = new Map<string, string | null>();

  // Iterative DFS (sessions can be thousands of entries deep).
  const stack: { entry: SessionEntry; shownParent: string | null }[] = [];
  const pushChildren = (parent: string | null, shownParent: string | null) => {
    const children = childrenOf.get(parent) ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      const entry = children[i];
      if (entry) stack.push({ entry, shownParent });
    }
  };
  pushChildren(null, null);
  while (stack.length > 0) {
    const { entry, shownParent } = stack.pop() as (typeof stack)[number];
    const shown = describe(entry);
    let nextShownParent = shownParent;
    if (shown) {
      const label = labels.get(entry.id);
      const item: TreeItem = {
        id: entry.id,
        kind: shown.kind,
        text: shown.text,
        timestamp: entry.timestamp,
        children: [],
        ...(label ? { label } : {}),
      };
      items.set(entry.id, item);
      if (shownParent === null) roots.push(entry.id);
      else items.get(shownParent)?.children.push(entry.id);
      nextShownParent = entry.id;
    }
    shownFor.set(entry.id, nextShownParent);
    pushChildren(entry.id, nextShownParent);
  }

  const currentId = leafId === null ? null : (shownFor.get(leafId) ?? null);
  const activePath = new Set<string>();
  const visited = new Set<string>();
  let cursor: string | null | undefined = leafId;
  while (cursor !== null && cursor !== undefined && !visited.has(cursor)) {
    visited.add(cursor);
    if (items.has(cursor)) activePath.add(cursor);
    cursor = byId.get(cursor)?.parentId;
  }
  return { items, roots, currentId, activePath };
}

export interface TreeRow {
  item: TreeItem;
  depth: number;
  /** Has more than one shown child (collapsible). */
  branchPoint: boolean;
  collapsed: boolean;
}

/** Rows in display order; children of collapsed branch points are skipped. */
export function flattenTree(model: TreeModel, collapsed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const stack: { id: string; depth: number }[] = [];
  const pushChildren = (ids: readonly string[], depth: number) => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i];
      if (id !== undefined) stack.push({ id, depth });
    }
  };
  pushChildren(model.roots, model.roots.length > 1 ? 1 : 0);
  while (stack.length > 0) {
    const { id, depth } = stack.pop() as { id: string; depth: number };
    const item = model.items.get(id);
    if (!item) continue;
    const branchPoint = item.children.length > 1;
    const isCollapsed = branchPoint && collapsed.has(id);
    rows.push({ item, depth, branchPoint, collapsed: isCollapsed });
    if (isCollapsed) continue;
    pushChildren(item.children, branchPoint ? depth + 1 : depth);
  }
  return rows;
}
