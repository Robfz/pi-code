/**
 * The Guide tab's Reviewed marks (`docs/design/11-pr-guide.md`, "Web client"), kept in this
 * browser (`pi-code:guide-reviewed`): per guide key, the guide generation they were made on and
 * its reviewed items. A key keeps one generation's marks, so a regenerated guide starts with none
 * and its predecessor's are dropped; the most recently marked `MAX_GUIDES` keys are kept.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const MAX_GUIDES = 100;

interface GuideMarks {
  /** The guide generation (`PrGuideResponse.id`). */
  id: string;
  /** Reviewed item indexes: sections, then "Other changes". */
  items: number[];
}

interface ReviewedStore {
  guides: Record<string, GuideMarks>;
  setReviewed(key: string, id: string, item: number, reviewed: boolean): void;
  /** Drops the key's marks unless they belong to generation `id`. */
  prune(key: string, id: string): void;
}

const NO_ITEMS: readonly number[] = [];

export const useReviewedStore = create<ReviewedStore>()(
  persist(
    (set) => ({
      guides: {},
      setReviewed: (key, id, item, reviewed) =>
        set(({ guides }) => {
          const { [key]: current, ...others } = guides;
          const kept = current?.id === id ? current.items.filter((i) => i !== item) : [];
          const items = reviewed ? [...kept, item].sort((a, b) => a - b) : kept;
          // Re-inserted last: the oldest keys are first and go first.
          const entries = Object.entries(others);
          if (items.length > 0) entries.push([key, { id, items }]);
          return { guides: Object.fromEntries(entries.slice(-MAX_GUIDES)) };
        }),
      prune: (key, id) =>
        set(({ guides }) => {
          if (guides[key] === undefined || guides[key].id === id) return {};
          const { [key]: _, ...others } = guides;
          return { guides: others };
        }),
    }),
    {
      name: "pi-code:guide-reviewed",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ guides }) => ({ guides }),
    },
  ),
);

/** The reviewed items of generation `id` of the guide `key`. */
export function useReviewedItems(key: string, id: string): readonly number[] {
  return useReviewedStore((state) => {
    const marks = state.guides[key];
    return marks?.id === id ? marks.items : NO_ITEMS;
  });
}
