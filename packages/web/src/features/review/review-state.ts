/**
 * Per-conversation review state (`docs/design/07-code-review.md`, "Review state"): the desktop
 * pane, the active tab, the Changes mode and the Files search and open file. Only open panes are
 * persisted (`pi-code:review`); the rest lasts for the tab's lifetime.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type ReviewTab = "changes" | "files";

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
  setTab(agentId: string, tab: ReviewTab): void;
  setDiffMode(agentId: string, diff: Partial<DiffMode>): void;
  /** Shows `path` in the Files tab, with `target` lines highlighted. */
  openFile(agentId: string, path: string, target?: Omit<FileTarget, "nonce">): void;
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
            .map(([agentId]) => [agentId, { paneOpen: true }]),
        ),
      }),
      merge: (persisted, current) => {
        const stored = (persisted as { reviews?: Record<string, unknown> } | undefined)?.reviews;
        const reviews = { ...current.reviews };
        for (const agentId of Object.keys(stored ?? {})) {
          reviews[agentId] = { ...(reviews[agentId] ?? DEFAULT_REVIEW), paneOpen: true };
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
