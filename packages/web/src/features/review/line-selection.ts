/**
 * The phone's pending line selection (`docs/design/07-code-review.md`, "Selectable diff"): one
 * at a time across the screen, owned by the `SelectableDiff` that started it.
 */

import { create } from "zustand";

export interface PendingSelection {
  /** The owning diff instance. */
  owner: string;
  side: "old" | "new";
  /** The first tapped line. */
  anchor: number;
  /** The last line, once the range is complete; either side of `anchor`. */
  end?: number;
}

interface LineSelectionStore {
  pending: PendingSelection | null;
  set(pending: PendingSelection): void;
  /** Clears the pending selection if `owner` owns it. */
  clear(owner: string): void;
}

export const useLineSelection = create<LineSelectionStore>()((set) => ({
  pending: null,
  set: (pending) => set({ pending }),
  clear: (owner) => set((state) => (state.pending?.owner === owner ? { pending: null } : state)),
}));
