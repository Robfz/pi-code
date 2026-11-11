/**
 * Per-conversation review state (`docs/design/07-code-review.md`, "Review state"): the desktop
 * pane, the active tab, the Changes mode, the Files search and open file, and the Tree tab's
 * collapsed branch points. Only open panes and their tab are persisted (`pi-code:review`); the
 * rest lasts for the tab's lifetime.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const REVIEW_TABS = ["guide", "changes", "files", "tree"] as const;
export type ReviewTab = (typeof REVIEW_TABS)[number];

export const TAB_LABEL: Record<ReviewTab, string> = {
  guide: "Guide",
  changes: "Changes",
  files: "Files",
  tree: "Tree",
};

/** The desktop pane's tabs: Guide only for a conversation attached to a PR. */
export function paneTabs(attached: boolean): readonly ReviewTab[] {
  return attached ? REVIEW_TABS : REVIEW_TABS.filter((tab) => tab !== "guide");
}

/** The phone page's tabs: the pane's but Tree, which has a page of its own. */
export function pageTabs(attached: boolean): readonly ReviewTab[] {
  return paneTabs(attached).filter((tab) => tab !== "tree");
}

/**
 * The tab a host offering `tabs` shows: Guide for a conversation attached to a PR until a tab is
 * picked (picks live in memory, so every reload gets the default), else the stored tab, or Changes
 * when the host doesn't offer it.
 */
export function tabOf(
  { tab, tabPicked }: Pick<ReviewState, "tab" | "tabPicked">,
  tabs: readonly ReviewTab[],
): ReviewTab {
  if (!tabPicked && tabs.includes("guide")) return "guide";
  return tabs.includes(tab) ? tab : "changes";
}

const isReviewTab = (value: unknown): value is ReviewTab =>
  REVIEW_TABS.includes(value as ReviewTab);

export type DiffModeName = "uncommitted" | "branch" | "pr";

export interface DiffMode {
  /** Unset until one is picked: see `diffModeOf`. */
  mode?: DiffModeName;
  /** The chosen base branch; the detected default applies until one is chosen. */
  base?: string;
  /** Branch mode: include uncommitted and untracked changes. */
  uncommitted: boolean;
}

/**
 * The mode the Changes tab shows: the picked one, by default PR mode for a conversation attached
 * to a PR (the mode lives in memory per agent id, so every reopen gets the default) and
 * uncommitted otherwise. PR mode needs the attachment.
 */
export function diffModeOf(diff: DiffMode, attached: boolean): DiffModeName {
  const mode = diff.mode ?? (attached ? "pr" : "uncommitted");
  return mode === "pr" && !attached ? "uncommitted" : mode;
}

/** New-side lines to highlight; a new `nonce` scrolls to them again. */
export interface FileTarget {
  start: number;
  end: number;
  nonce: number;
}

export interface ReviewState {
  /** Desktop only. */
  paneOpen: boolean;
  /** The tab last picked, else the persisted one: see `tabOf`. */
  tab: ReviewTab;
  /** Whether `tab` was picked since the page loaded. */
  tabPicked: boolean;
  diff: DiffMode;
  /** The open file, as committed in `rev` when set, else its working-tree copy. */
  files: { query: string; path?: string; rev?: string; target?: FileTarget };
  /** Branch points collapsed in the session tree, by entry id. */
  tree: { collapsed: string[] };
}

export const DEFAULT_REVIEW: ReviewState = {
  paneOpen: false,
  tab: "changes",
  tabPicked: false,
  diff: { uncommitted: false },
  files: { query: "" },
  tree: { collapsed: [] },
};

interface ReviewStore {
  reviews: Record<string, ReviewState>;
  /** Opens the pane, on `tab` or the stored one. */
  openPane(agentId: string, tab?: ReviewTab): void;
  togglePane(agentId: string): void;
  /** Opens the pane on `tab`, or closes it when it already shows `tab` (offering `tabs`). */
  toggleTab(agentId: string, tab: ReviewTab, tabs: readonly ReviewTab[]): void;
  setTab(agentId: string, tab: ReviewTab): void;
  setDiffMode(agentId: string, diff: Partial<DiffMode>): void;
  /** Shows `path` (as committed in `rev`, if given) in the Files tab, `target` lines highlighted. */
  openFile(agentId: string, path: string, target?: Omit<FileTarget, "nonce">, rev?: string): void;
  /** Back from the open file to the Files search. */
  closeFile(agentId: string): void;
  setFilesQuery(agentId: string, query: string): void;
  /** Collapses the tree's branch point `entryId`, or expands it when collapsed. */
  toggleTreeBranch(agentId: string, entryId: string): void;
}

let nextNonce = 1;

export const useReviewStore = create<ReviewStore>()(
  persist(
    (set) => {
      const update = (agentId: string, change: (review: ReviewState) => Partial<ReviewState>) =>
        set((state) => {
          const review = state.reviews[agentId] ?? DEFAULT_REVIEW;
          return { reviews: { ...state.reviews, [agentId]: { ...review, ...change(review) } } };
        });
      return {
        reviews: {},
        openPane: (agentId, tab) =>
          update(agentId, () => ({ paneOpen: true, ...(tab && { tab, tabPicked: true }) })),
        togglePane: (agentId) => update(agentId, (review) => ({ paneOpen: !review.paneOpen })),
        toggleTab: (agentId, tab, tabs) =>
          update(agentId, (review) => ({
            paneOpen: !(review.paneOpen && tabOf(review, tabs) === tab),
            tab,
            tabPicked: true,
          })),
        setTab: (agentId, tab) => update(agentId, () => ({ tab, tabPicked: true })),
        setDiffMode: (agentId, diff) =>
          update(agentId, (review) => ({ diff: { ...review.diff, ...diff } })),
        openFile: (agentId, path, target, rev) =>
          update(agentId, (review) => ({
            tab: "files",
            tabPicked: true,
            files: {
              query: review.files.query,
              path,
              ...(rev !== undefined && { rev }),
              ...(target && { target: { ...target, nonce: nextNonce++ } }),
            },
          })),
        closeFile: (agentId) =>
          update(agentId, (review) => ({ files: { query: review.files.query } })),
        setFilesQuery: (agentId, query) =>
          update(agentId, (review) => ({ files: { ...review.files, query } })),
        toggleTreeBranch: (agentId, entryId) =>
          update(agentId, ({ tree }) => ({
            tree: {
              collapsed: tree.collapsed.includes(entryId)
                ? tree.collapsed.filter((id) => id !== entryId)
                : [...tree.collapsed, entryId],
            },
          })),
      };
    },
    {
      name: "pi-code:review",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        reviews: Object.fromEntries(
          Object.entries(state.reviews)
            .filter(([, review]) => review.paneOpen)
            .map(([agentId, review]) => [agentId, { paneOpen: true, tab: review.tab }]),
        ),
      }),
      merge: (persisted, current) => {
        const stored = (persisted as { reviews?: Record<string, { tab?: unknown }> } | undefined)
          ?.reviews;
        const reviews = { ...current.reviews };
        for (const [agentId, entry] of Object.entries(stored ?? {})) {
          // Other builds may store no tab or one this build lacks.
          const tab = isReviewTab(entry?.tab) ? entry.tab : "changes";
          reviews[agentId] = { ...(reviews[agentId] ?? DEFAULT_REVIEW), paneOpen: true, tab };
        }
        return { ...current, reviews };
      },
    },
  ),
);

/** The conversation's review state, with defaults. */
export function useReview(agentId: string): ReviewState {
  return useReviewStore((state) => state.reviews[agentId] ?? DEFAULT_REVIEW);
}

/**
 * Shows a conversation just attached to a PR on its guide, as `/pr` and "Review PR" do: the
 * Changes tab in PR mode, and the pane opened on Guide (desktop) or the Guide tab picked (phone).
 */
export function openPrGuide(agentId: string, desktop: boolean): void {
  const review = useReviewStore.getState();
  review.setDiffMode(agentId, { mode: "pr" });
  if (desktop) review.openPane(agentId, "guide");
  else review.setTab(agentId, "guide");
}
