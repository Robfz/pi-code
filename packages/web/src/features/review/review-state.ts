/**
 * Per-conversation review state (`docs/design/07-code-review.md`, "Review state"): the desktop
 * pane, the active tab, the Changes mode and the Files search and open file. Only open panes and
 * their tab are persisted (`pi-code:review`); the rest lasts for the tab's lifetime.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const REVIEW_TABS = ["changes", "files", "tree"] as const;
export type ReviewTab = (typeof REVIEW_TABS)[number];

/** The phone page's tabs: Tree is the pane's only. */
export const PAGE_TABS: readonly ReviewTab[] = ["changes", "files"];

export const TAB_LABEL: Record<ReviewTab, string> = {
  changes: "Changes",
  files: "Files",
  tree: "Tree",
};

const isReviewTab = (value: unknown): value is ReviewTab =>
  REVIEW_TABS.includes(value as ReviewTab);

export interface DiffMode {
  mode: "uncommitted" | "branch";
  /** The chosen base branch; the detected default applies until one is chosen. */
  base?: string;
  /** Branch mode: include uncommitted and untracked changes. */
  uncommitted: boolean;
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
  tab: ReviewTab;
  diff: DiffMode;
  files: { query: string; path?: string; target?: FileTarget };
}

export const DEFAULT_REVIEW: ReviewState = {
  paneOpen: false,
  tab: "changes",
  diff: { mode: "uncommitted", uncommitted: false },
  files: { query: "" },
};

interface ReviewStore {
  reviews: Record<string, ReviewState>;
  /** Opens the pane, on `tab` or the stored one. */
  openPane(agentId: string, tab?: ReviewTab): void;
  togglePane(agentId: string): void;
  /** Opens the pane on `tab`, or closes it when it already shows `tab`. */
  toggleTab(agentId: string, tab: ReviewTab): void;
  setTab(agentId: string, tab: ReviewTab): void;
  setDiffMode(agentId: string, diff: Partial<DiffMode>): void;
  /** Shows `path` in the Files tab, with `target` lines highlighted. */
  openFile(agentId: string, path: string, target?: Omit<FileTarget, "nonce">): void;
  /** Back from the open file to the Files search. */
  closeFile(agentId: string): void;
  setFilesQuery(agentId: string, query: string): void;
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
          update(agentId, (review) => ({ paneOpen: true, tab: tab ?? review.tab })),
        togglePane: (agentId) => update(agentId, (review) => ({ paneOpen: !review.paneOpen })),
        toggleTab: (agentId, tab) =>
          update(agentId, (review) => ({
            paneOpen: !(review.paneOpen && review.tab === tab),
            tab,
          })),
        setTab: (agentId, tab) => update(agentId, () => ({ tab })),
        setDiffMode: (agentId, diff) =>
          update(agentId, (review) => ({ diff: { ...review.diff, ...diff } })),
        openFile: (agentId, path, target) =>
          update(agentId, (review) => ({
            tab: "files",
            files: {
              query: review.files.query,
              path,
              ...(target && { target: { ...target, nonce: nextNonce++ } }),
            },
          })),
        closeFile: (agentId) =>
          update(agentId, (review) => ({ files: { query: review.files.query } })),
        setFilesQuery: (agentId, query) =>
          update(agentId, (review) => ({ files: { ...review.files, query } })),
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
