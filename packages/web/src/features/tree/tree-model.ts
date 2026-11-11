/**
 * Display model for the session tree screen, built from the store's transcript (which holds
 * every branch) and its labels: entries reduced to user / assistant messages plus compaction
 * and branch-summary markers. Tool traffic (tool-only assistant turns, tool results) and state
 * entries are hidden; their children attach to the nearest shown ancestor. Linear chains stay
 * at one depth; each branch point's children start one level deeper. `flattenTree` turns the
 * model into rows with the connector guides of a git-graph-style gutter.
 */

import { prBlockLabel, type SessionEntry, skillCommand, splitUserMessage } from "@pi-code/protocol";
import { baseName, contentText } from "@/lib/content";
import { formatTokens } from "@/lib/time";

export type TreeRowKind = "user" | "assistant" | "compaction" | "branch_summary";

export interface TreeItem {
  id: string;
  kind: TreeRowKind;
  /** One-line preview (see `previewText`). */
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

/** Longest row preview, in characters. */
export const PREVIEW_CHARS = 200;

/**
 * `text` as a one-line preview: whitespace collapsed, at most `PREVIEW_CHARS` characters plus an
 * ellipsis. Only the start of the text is scanned, so huge messages cost no more than short ones.
 */
export function previewText(text: string): string {
  const scanned = PREVIEW_CHARS * 4;
  const line = text.slice(0, scanned).replace(/\s+/g, " ").trim();
  if (line.length <= PREVIEW_CHARS && text.length <= scanned) return line;
  return `${line.slice(0, PREVIEW_CHARS).trimEnd()}…`;
}

/**
 * A user message's PR (`(PR #12 Title)`) or PR guide (`(Guide #12 Title)`), else its skill
 * command, else its typed text, else its attached file names, else "(image)".
 */
function userText(text: string): string {
  const { skill, files, prs, guides, body } = splitUserMessage(text);
  if (prs[0] !== undefined) return `(PR ${prBlockLabel(prs[0])})`;
  if (guides[0] !== undefined) return `(Guide #${guides[0].number} ${guides[0].title})`;
  if (skill) return skillCommand(skill.name, body);
  if (body.trim() !== "") return body;
  if (files.length > 0) return `(file: ${files.map((f) => baseName(f.name)).join(", ")})`;
  return "(image)";
}

export interface EntryDescription {
  kind: TreeRowKind;
  text: string;
}

function describeUncached(entry: SessionEntry): EntryDescription | null {
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      if (message.role === "user") {
        return { kind: "user", text: previewText(userText(contentText(message.content))) };
      }
      if (message.role === "assistant") {
        const text = previewText(contentText(message.content));
        if (text !== "") return { kind: "assistant", text };
        if (message.errorMessage)
          return { kind: "assistant", text: previewText(`Error: ${message.errorMessage}`) };
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
      return { kind: "branch_summary", text: previewText(entry.summary ?? "") || "Branch summary" };
    default:
      return null;
  }
}

/** Entries are immutable, so each is described once, however often the model is rebuilt. */
const descriptions = new WeakMap<SessionEntry, EntryDescription | null>();

/** The entry's row kind and preview, or null when the tree hides it. */
export function describeEntry(entry: SessionEntry): EntryDescription | null {
  let description = descriptions.get(entry);
  if (description === undefined) {
    description = describeUncached(entry);
    descriptions.set(entry, description);
  }
  return description;
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
    const shown = describeEntry(entry);
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

/**
 * A row's place in the gutter. A row at depth `d` has guide columns `0..d-1`, then its node in
 * column `d`. Each branch point's branches start one column right of it, so the elbows of its
 * branches sit in the branch point's node column.
 */
export interface TreeRow {
  item: TreeItem;
  depth: number;
  /** Has more than one shown child (collapsible). */
  branchPoint: boolean;
  collapsed: boolean;
  /**
   * Per guide column (`depth` of them): whether a vertical line crosses the whole row there,
   * because the branch owning that column has later sibling branches below.
   */
  guides: boolean[];
  /**
   * First row of a branch: the connector in column `depth - 1`, `mid` (├) when sibling branches
   * follow, `last` (└) for the last branch, `first` (┌) for the first of several roots, which
   * has nothing above it.
   */
  elbow: "first" | "mid" | "last" | null;
  /** The node links up to the previous row in its own column (it continues a linear chain). */
  linkUp: boolean;
  /** The node links down to its children (it has some and isn't collapsed). */
  linkDown: boolean;
}

/**
 * Rows in display order; children of collapsed branch points are skipped. Several roots are
 * branches of a virtual root, so they start at depth 1 with elbows.
 */
export function flattenTree(model: TreeModel, collapsed: ReadonlySet<string>): TreeRow[] {
  interface Pending {
    id: string;
    depth: number;
    guides: boolean[];
    elbow: TreeRow["elbow"];
    linkUp: boolean;
  }
  const rows: TreeRow[] = [];
  const stack: Pending[] = [];
  /**
   * Pushes `ids` as the branches of a branch point whose node sits in column `depth - 1`, or of
   * the virtual root (`roots`), which has no node.
   */
  const pushBranches = (
    ids: readonly string[],
    depth: number,
    guides: readonly boolean[],
    roots = false,
  ) => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i];
      const last = i === ids.length - 1;
      if (id !== undefined) {
        stack.push({
          id,
          depth,
          guides: [...guides, !last],
          elbow: last ? "last" : roots && i === 0 ? "first" : "mid",
          linkUp: false,
        });
      }
    }
  };
  const [onlyRoot] = model.roots;
  if (model.roots.length === 1 && onlyRoot !== undefined) {
    stack.push({ id: onlyRoot, depth: 0, guides: [], elbow: null, linkUp: false });
  } else {
    pushBranches(model.roots, 1, [], true);
  }
  while (stack.length > 0) {
    const { id, depth, guides, elbow, linkUp } = stack.pop() as Pending;
    const item = model.items.get(id);
    if (!item) continue;
    const branchPoint = item.children.length > 1;
    const isCollapsed = branchPoint && collapsed.has(id);
    const linkDown = !isCollapsed && item.children.length > 0;
    rows.push({
      item,
      depth,
      branchPoint,
      collapsed: isCollapsed,
      guides,
      elbow,
      linkUp,
      linkDown,
    });
    if (!linkDown) continue;
    const [onlyChild] = item.children;
    if (branchPoint) pushBranches(item.children, depth + 1, guides);
    // A linear chain stays in its branch, so its guides carry over.
    else if (onlyChild !== undefined) {
      stack.push({ id: onlyChild, depth, guides, elbow: null, linkUp: true });
    }
  }
  return rows;
}
