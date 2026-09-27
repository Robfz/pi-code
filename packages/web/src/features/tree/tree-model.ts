/**
 * Display model for the session tree screen: `get_tree` nodes reduced to user / assistant
 * messages plus compaction and branch-summary markers. Tool traffic (tool-only assistant
 * turns, tool results) and state entries are hidden; their children attach to the nearest
 * shown ancestor. Linear chains stay at one depth; each branch point indents its children.
 */

import type { SessionEntry, SessionTreeNode } from "@pi-code/protocol";
import { contentText } from "@/lib/content";

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

function describe(entry: SessionEntry): { kind: TreeRowKind; text: string } | null {
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      if (message.role === "user") {
        return { kind: "user", text: contentText(message.content).trim() || "(image)" };
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
        text: `Context compacted (${entry.tokensBefore.toLocaleString("en-US")} tokens)`,
      };
    case "branch_summary":
      return { kind: "branch_summary", text: "Branch summary" };
    default:
      return null;
  }
}

export function buildTreeModel(tree: readonly SessionTreeNode[], leafId: string | null): TreeModel {
  const items = new Map<string, TreeItem>();
  const roots: string[] = [];
  const parentOf = new Map<string, string | null>();
  /** Nearest shown ancestor-or-self per entry. */
  const shownFor = new Map<string, string | null>();

  // Iterative DFS (sessions can be thousands of entries deep).
  const stack: { node: SessionTreeNode; shownParent: string | null; parent: string | null }[] = [];
  for (let i = tree.length - 1; i >= 0; i--) {
    const node = tree[i];
    if (node) stack.push({ node, shownParent: null, parent: null });
  }
  while (stack.length > 0) {
    const { node, shownParent, parent } = stack.pop() as (typeof stack)[number];
    const entry = node.entry;
    parentOf.set(entry.id, parent);
    const shown = describe(entry);
    let nextShownParent = shownParent;
    if (shown) {
      const item: TreeItem = {
        id: entry.id,
        kind: shown.kind,
        text: shown.text,
        timestamp: entry.timestamp,
        children: [],
        ...(node.label ? { label: node.label } : {}),
      };
      items.set(entry.id, item);
      if (shownParent === null) roots.push(entry.id);
      else items.get(shownParent)?.children.push(entry.id);
      nextShownParent = entry.id;
    }
    shownFor.set(entry.id, nextShownParent);
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (child) stack.push({ node: child, shownParent: nextShownParent, parent: entry.id });
    }
  }

  const currentId = leafId === null ? null : (shownFor.get(leafId) ?? null);
  const activePath = new Set<string>();
  let cursor: string | null | undefined = leafId;
  while (cursor !== null && cursor !== undefined) {
    if (items.has(cursor)) activePath.add(cursor);
    cursor = parentOf.get(cursor);
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
