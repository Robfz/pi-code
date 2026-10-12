import { describe, expect, it } from "vitest";
import { applySidebarPatch } from "./sidebar.ts";

describe("applySidebarPatch", () => {
  it("sets and clears flags idempotently, leaving untouched lists as they are", () => {
    const state = { pinned: ["/a"], collapsed: ["/a", "/b"] };
    const next = applySidebarPatch(state, {
      pinned: { "/a": true, "/c": true },
      collapsed: { "/a": false, "/z": false },
    });
    expect(next).toEqual({ pinned: ["/a", "/c"], collapsed: ["/b"] });
    expect(state).toEqual({ pinned: ["/a"], collapsed: ["/a", "/b"] });
    expect(applySidebarPatch(state, { collapsed: { "/b": true } }).pinned).toBe(state.pinned);
  });
});
