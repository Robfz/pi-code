import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEW, diffModeOf, useReview, useReviewStore } from "./review-state";

const review = (agentId: string) => useReviewStore.getState().reviews[agentId] ?? DEFAULT_REVIEW;
const stored = () => JSON.parse(localStorage.getItem("pi-code:review") ?? "null")?.state;

/** A reload: the in-memory state is gone and the persisted one is read back. */
async function reload() {
  const saved = localStorage.getItem("pi-code:review") ?? "";
  useReviewStore.setState({ reviews: {} });
  localStorage.setItem("pi-code:review", saved);
  await useReviewStore.persist.rehydrate();
}

describe("review state", () => {
  it("reads defaults for an unknown conversation", () => {
    const { result } = renderHook(() => useReview("a1"));
    expect(result.current).toEqual({
      paneOpen: false,
      tab: "changes",
      diff: { uncommitted: false },
      files: { query: "" },
      tree: { collapsed: [] },
    });
  });

  it("defaults to PR mode when attached to a PR, else uncommitted; a picked mode stays", () => {
    expect(diffModeOf({ uncommitted: false }, false)).toBe("uncommitted");
    expect(diffModeOf({ uncommitted: false }, true)).toBe("pr");
    expect(diffModeOf({ mode: "branch", uncommitted: false }, true)).toBe("branch");
    expect(diffModeOf({ mode: "uncommitted", uncommitted: false }, true)).toBe("uncommitted");
    expect(diffModeOf({ mode: "pr", uncommitted: false }, true)).toBe("pr");
    // Not (or no longer known to be) attached.
    expect(diffModeOf({ mode: "pr", uncommitted: false }, false)).toBe("uncommitted");
  });

  it("toggles the tree's collapsed branch points, without persisting them", () => {
    const { openPane, toggleTreeBranch } = useReviewStore.getState();
    openPane("a1", "tree");
    toggleTreeBranch("a1", "e1");
    toggleTreeBranch("a1", "e2");
    expect(review("a1").tree.collapsed).toEqual(["e1", "e2"]);
    toggleTreeBranch("a1", "e1");
    expect(review("a1").tree.collapsed).toEqual(["e2"]);
    expect(localStorage.getItem("pi-code:review")).not.toContain("e2");
  });

  it("updates one conversation's entry", () => {
    const { openPane, togglePane, setTab, setDiffMode, openFile, setFilesQuery } =
      useReviewStore.getState();
    setTab("a1", "files");
    openPane("a1");
    expect(review("a1")).toMatchObject({ paneOpen: true, tab: "files" });
    togglePane("a1");
    openPane("a1", "changes");
    expect(review("a1")).toMatchObject({ paneOpen: true, tab: "changes" });

    setDiffMode("a1", { mode: "branch" });
    setDiffMode("a1", { base: "dev", uncommitted: true });
    expect(review("a1").diff).toEqual({ mode: "branch", base: "dev", uncommitted: true });

    setFilesQuery("a1", "gitts");
    openFile("a1", "src/a.ts", { start: 3, end: 4 });
    const first = review("a1").files.target?.nonce;
    expect(review("a1")).toMatchObject({
      tab: "files",
      files: { query: "gitts", path: "src/a.ts", target: { start: 3, end: 4 } },
    });
    openFile("a1", "src/a.ts", { start: 3, end: 4 });
    expect(review("a1").files.target?.nonce).not.toBe(first);
    openFile("a1", "src/b.ts", { start: 1, end: 1 }, "3f2a9c1");
    expect(review("a1").files).toMatchObject({ path: "src/b.ts", rev: "3f2a9c1" });
    openFile("a1", "src/b.ts");
    expect(review("a1").files).toEqual({ query: "gitts", path: "src/b.ts" });
    useReviewStore.getState().closeFile("a1");
    expect(review("a1")).toMatchObject({ tab: "files", files: { query: "gitts" } });
    expect(review("a1").files.path).toBeUndefined();

    expect(review("a2")).toBe(DEFAULT_REVIEW);
  });

  it("toggles a tab: opens the pane on it, closes the pane when it already shows it", () => {
    const { toggleTab } = useReviewStore.getState();
    toggleTab("a1", "tree");
    expect(review("a1")).toMatchObject({ paneOpen: true, tab: "tree" });
    toggleTab("a1", "files");
    expect(review("a1")).toMatchObject({ paneOpen: true, tab: "files" });
    toggleTab("a1", "files");
    expect(review("a1")).toMatchObject({ paneOpen: false, tab: "files" });
    toggleTab("a1", "files");
    expect(review("a1")).toMatchObject({ paneOpen: true, tab: "files" });
  });

  it("persists only open panes, with their tab", async () => {
    const { openPane, togglePane, setDiffMode, setFilesQuery } = useReviewStore.getState();
    openPane("a1", "files");
    setDiffMode("a1", { mode: "branch", base: "dev" });
    setFilesQuery("a1", "gitts");
    openPane("a2");
    togglePane("a2");
    setDiffMode("a3", { mode: "branch" });
    expect(stored()).toEqual({ reviews: { a1: { paneOpen: true, tab: "files" } } });

    await reload();
    expect(useReviewStore.getState().reviews).toEqual({
      a1: { ...DEFAULT_REVIEW, paneOpen: true, tab: "files" },
    });

    useReviewStore.getState().togglePane("a1");
    expect(stored()).toEqual({ reviews: {} });
    await reload();
    expect(useReviewStore.getState().reviews).toEqual({});
  });

  it("reads a stored pane without a tab, or with an unknown one, on Changes", async () => {
    localStorage.setItem(
      "pi-code:review",
      JSON.stringify({
        state: { reviews: { a1: { paneOpen: true }, a2: { paneOpen: true, tab: "terminal" } } },
        version: 0,
      }),
    );
    await useReviewStore.persist.rehydrate();
    expect(useReviewStore.getState().reviews).toEqual({
      a1: { ...DEFAULT_REVIEW, paneOpen: true },
      a2: { ...DEFAULT_REVIEW, paneOpen: true },
    });
  });
});
