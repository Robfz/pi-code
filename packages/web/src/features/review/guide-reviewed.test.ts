import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MAX_GUIDES, useReviewedItems, useReviewedStore } from "./guide-reviewed";

const stored = () => JSON.parse(localStorage.getItem("pi-code:guide-reviewed") ?? "null")?.state;
const items = (key: string, id: string) => renderHook(() => useReviewedItems(key, id)).result;

describe("Reviewed marks", () => {
  it("marks and unmarks items of one generation, persisted", async () => {
    const { setReviewed } = useReviewedStore.getState();
    setReviewed("k", "g1", 2, true);
    setReviewed("k", "g1", 0, true);
    expect(items("k", "g1").current).toEqual([0, 2]);
    setReviewed("k", "g1", 2, false);
    expect(stored()).toEqual({ guides: { k: { id: "g1", items: [0] } } });

    // A reload: the in-memory state is gone and the persisted one is read back.
    const saved = localStorage.getItem("pi-code:guide-reviewed") ?? "";
    useReviewedStore.setState({ guides: {} });
    localStorage.setItem("pi-code:guide-reviewed", saved);
    await useReviewedStore.persist.rehydrate();
    expect(items("k", "g1").current).toEqual([0]);

    // The last mark gone, the key goes too.
    setReviewed("k", "g1", 0, false);
    expect(stored()).toEqual({ guides: {} });
  });

  it("has none for a new generation, whose first mark replaces the old ones", () => {
    const { setReviewed } = useReviewedStore.getState();
    setReviewed("k", "g1", 0, true);
    setReviewed("other", "g9", 1, true);
    expect(items("k", "g2").current).toEqual([]);
    setReviewed("k", "g2", 3, true);
    expect(stored().guides).toEqual({
      other: { id: "g9", items: [1] },
      k: { id: "g2", items: [3] },
    });
  });

  it("prunes a key's marks of other generations", () => {
    const { setReviewed, prune } = useReviewedStore.getState();
    setReviewed("k", "g1", 0, true);
    prune("k", "g1");
    expect(items("k", "g1").current).toEqual([0]);
    prune("k", "g2");
    expect(stored().guides).toEqual({});
  });

  it("keeps the most recently marked guides", () => {
    const { setReviewed } = useReviewedStore.getState();
    for (let i = 0; i <= MAX_GUIDES; i++) setReviewed(`k${i}`, "g", 0, true);
    const keys = Object.keys(stored().guides);
    expect(keys).toHaveLength(MAX_GUIDES);
    expect(keys).not.toContain("k0");
    // Marking again makes a key the most recent.
    setReviewed("k1", "g", 1, true);
    setReviewed("new", "g", 0, true);
    expect(Object.keys(stored().guides)).toContain("k1");
    expect(Object.keys(stored().guides)).not.toContain("k2");
  });
});
