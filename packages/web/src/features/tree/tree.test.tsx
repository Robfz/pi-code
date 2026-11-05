import {
  formatPrBlock,
  initialLiveState,
  type NavigateResponse,
  type SessionEntry,
} from "@pi-code/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationUi } from "@/features/conversation/conversation-ui";
import { useReviewStore } from "@/features/review/review-state";
import { RELATIVE_TIME_TICK_MS } from "@/lib/use-now";
import { useDrafts } from "@/store/drafts";
import { stubMatchMedia } from "@/test/dom-stubs";
import { makeAgent, makePr } from "@/test/fixtures";
import { type FetchCall, hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import {
  buildTreeModel,
  describeEntry,
  flattenTree,
  PREVIEW_CHARS,
  type TreeModel,
} from "./tree-model";
import { TreeScreen } from "./tree-screen";
import { TreeView } from "./tree-view";

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return {
    ...actual,
    toast: Object.assign(vi.fn(), {
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    }),
  };
});

let clock = 0;
function entry(id: string, parentId: string | null, body: Record<string, unknown>): SessionEntry {
  clock++;
  return {
    id,
    parentId,
    timestamp: new Date(clock * 1000).toISOString(),
    ...body,
  } as unknown as SessionEntry;
}
const user = (id: string, parent: string | null, text: string) =>
  entry(id, parent, { type: "message", message: { role: "user", content: text, timestamp: 0 } });
const assistant = (id: string, parent: string, content: unknown[]) =>
  entry(id, parent, {
    type: "message",
    message: { role: "assistant", content, stopReason: "stop", timestamp: 0 },
  });
const toolResult = (id: string, parent: string) =>
  entry(id, parent, {
    type: "message",
    message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "ok" }] },
  });

const label = (id: string, targetId: string, text: string | undefined) =>
  entry(id, null, { type: "label", targetId, label: text });

/**
 * u1 → a1 ─┬→ u2 [label "checkpoint"] → a2 (tool only) → tr → a3 (leaf)
 *          └→ u3 → a4
 *                   └→ compaction
 *
 * Entries in session order, like the store's transcript (all branches).
 */
function sampleTree(): { entries: SessionEntry[]; leafId: string } {
  const u1 = user("u1", null, "Build the thing");
  const a1 = assistant("a1", "u1", [{ type: "text", text: "Sure, plan below" }]);
  const u2 = user("u2", "a1", "Go with plan A");
  const a2 = assistant("a2", "u2", [{ type: "toolCall", id: "t1", name: "read", arguments: {} }]);
  const tr = toolResult("tr", "a2");
  const a3 = assistant("a3", "tr", [{ type: "text", text: "Plan A done" }]);
  const u3 = user("u3", "a1", "Try plan B instead");
  const a4 = assistant("a4", "u3", [{ type: "text", text: "Plan B done" }]);
  const compaction = entry("c1", "a4", {
    type: "compaction",
    summary: "summary",
    firstKeptEntryId: "u3",
    tokensBefore: 12345,
  });
  return {
    entries: [
      u1,
      a1,
      u2,
      a2,
      tr,
      a3,
      u3,
      a4,
      compaction,
      label("l1", "u2", "old name"),
      label("l2", "u2", "checkpoint"),
    ],
    leafId: "a3",
  };
}

function sampleStore(running = false) {
  const { entries, leafId } = sampleTree();
  return hydratedStore({
    transcript: { entries, leafId },
    ...(running ? { live: { ...initialLiveState(), run: { active: true } } } : {}),
  });
}

const labelsOf = (entries: SessionEntry[]) =>
  new Map(
    entries.flatMap((e) =>
      e.type === "label" && e.label ? [[e.targetId, e.label] as [string, string]] : [],
    ),
  );

const rpcBodies = (calls: FetchCall[]) =>
  calls.filter((c) => c.url === "/api/agents/a1/rpc").map((c) => c.body);

function handler(navigateResult: { cancelled: boolean } = { cancelled: false }) {
  return (call: FetchCall): [number, unknown] | undefined => {
    if (call.url === "/api/agents/a1/rpc") {
      const type = (call.body as { type: string }).type;
      if (type === "fork") return [200, { data: { text: "Try plan B instead", cancelled: false } }];
    }
    if (call.url === "/api/agents/a1/tree/navigate") return [200, navigateResult];
    return undefined;
  };
}

/** `handler` with a navigate request that stays pending until `respond`. */
function pendingNavigate() {
  let respond: (result: NavigateResponse) => void = () => {};
  const result = new Promise<NavigateResponse>((resolve) => {
    respond = resolve;
  });
  const base = handler();
  return {
    respond,
    handler: async (call: FetchCall): Promise<[number, unknown] | undefined> =>
      call.url === "/api/agents/a1/tree/navigate" ? [200, await result] : base(call),
  };
}

async function renderTree(running = false) {
  const store = sampleStore(running);
  const result = await renderWithStore(<TreeScreen />, store);
  await result.router.navigate({ to: "/agents/$agentId/tree", params: { agentId: "a1" } });
  await screen.findAllByTestId("tree-row");
  return { ...result, store };
}

const rows = () => screen.getAllByTestId("tree-row");
const row = (id: string) =>
  rows().find((r) => r.dataset.entryId === id) ?? (null as unknown as HTMLElement);
const selectedRows = () =>
  rows()
    .filter((r) => r.getAttribute("aria-selected") === "true")
    .map((r) => r.dataset.entryId);

beforeEach(() => {
  useConversationUi.getState().reset();
  vi.mocked(toast.info).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tree model", () => {
  it("hides tool traffic, keeps markers, indents only at branch points", () => {
    const { entries, leafId } = sampleTree();
    const model = buildTreeModel(entries, leafId, labelsOf(entries));
    const flat = flattenTree(model, new Set());
    expect(flat.map((r) => [r.item.id, r.depth])).toEqual([
      ["u1", 0],
      ["a1", 0],
      ["u2", 1],
      ["a3", 1],
      ["u3", 1],
      ["a4", 1],
      ["c1", 1],
    ]);
    expect(model.currentId).toBe("a3");
    expect([...model.activePath].sort()).toEqual(["a1", "a3", "u1", "u2"]);
    expect(model.items.get("u2")?.label).toBe("checkpoint");
    expect(model.items.get("c1")?.text).toBe("Context compacted (12k tokens)");
    // Collapsing a branch point hides its subtree.
    expect(flattenTree(model, new Set(["a1"])).map((r) => r.item.id)).toEqual(["u1", "a1"]);
  });

  it("shows user text without attached file blocks", () => {
    const block = '<file name="a.ts">\nx\n</file>\n';
    const entries = [
      user("u1", null, `${block}explain`),
      user("u2", "u1", block),
      user("u3", "u2", ""),
    ];
    const model = buildTreeModel(entries, "u3");
    expect(["u1", "u2", "u3"].map((id) => model.items.get(id)?.text)).toEqual([
      "explain",
      "(file: a.ts)",
      "(image)",
    ]);
  });

  it("names a PR review prompt by its PR", () => {
    const block = formatPrBlock({
      number: 12,
      title: "Speed up",
      state: "open",
      url: "u",
      update: false,
      text: "context",
    });
    const model = buildTreeModel([user("u1", null, `${block}Give me an overview`)], "u1");
    expect(model.items.get("u1")?.text).toBe("(PR #12 Speed up)");
  });

  it("maps a hidden leaf to its nearest shown ancestor", () => {
    const { entries } = sampleTree();
    expect(buildTreeModel(entries, "tr").currentId).toBe("u2");
  });

  it("doesn't cap depth: deep rows get one gutter column per level", async () => {
    // A chain of nested branch points.
    const entries: SessionEntry[] = [];
    for (let i = 0; i <= 10; i++) {
      entries.push(user(`n${i}`, i === 0 ? null : `n${i - 1}`, `msg ${i}`));
      if (i > 0) entries.push(user(`s${i}`, `n${i - 1}`, `side ${i}`));
    }
    await renderWithStore(<TreeScreen />, hydratedStore({ transcript: { entries, leafId: "n0" } }));
    await screen.findAllByTestId("tree-row");
    const deepest = row("n10");
    expect(deepest.dataset.depth).toBe("10");
    expect(deepest).toHaveAttribute("aria-level", "11");
    // Ten guide columns, then the node.
    expect(deepest.querySelector('[data-slot="tree-gutter"]')?.children).toHaveLength(11);
  });

  it("describes each entry once, as a bounded one-line preview", () => {
    const long = user("u1", null, `first   line\n\nsecond ${"word ".repeat(5000)}`);
    const description = describeEntry(long);
    expect(describeEntry(long)).toBe(description);
    expect(description?.text.startsWith("first line second word")).toBe(true);
    expect(description?.text.length).toBe(PREVIEW_CHARS + 1);
    expect(description?.text.endsWith("…")).toBe(true);
    expect(describeEntry(user("u2", null, "short\ntext"))?.text).toBe("short text");
  });

  it("shows a branch summary's text", () => {
    const summary = (id: string, text: string) =>
      entry(id, "u1", { type: "branch_summary", fromId: "x", summary: text });
    const model = buildTreeModel(
      [user("u1", null, "hi"), summary("b1", "Tried plan A"), summary("b2", "")],
      "b1",
    );
    expect(model.items.get("b1")?.text).toBe("Tried plan A");
    expect(model.items.get("b2")?.text).toBe("Branch summary");
  });
});

/** `id depth guides elbow links`: guides as `|` (line) / `.`, links `^` up and `v` down. */
function gutter(model: TreeModel, collapsed: string[] = []): string[] {
  return flattenTree(model, new Set(collapsed)).map((r) =>
    [
      r.item.id,
      r.depth,
      r.guides.map((g) => (g ? "|" : ".")).join("") || "-",
      r.elbow ?? "-",
      `${r.linkUp ? "^" : ""}${r.linkDown ? "v" : ""}` || "-",
    ].join(" "),
  );
}

describe("tree guides", () => {
  it("a single chain has no guides, only links", () => {
    const model = buildTreeModel(
      [
        user("u1", null, "a"),
        assistant("a1", "u1", [{ type: "text", text: "b" }]),
        user("u2", "a1", "c"),
      ],
      "u2",
    );
    expect(gutter(model)).toEqual(["u1 0 - - v", "a1 0 - - ^v", "u2 0 - - ^"]);
  });

  it("branches of a branch point get ├ elbows, the last └; chains keep their branch's line", () => {
    const { entries, leafId } = sampleTree();
    expect(gutter(buildTreeModel(entries, leafId))).toEqual([
      "u1 0 - - v",
      "a1 0 - - ^v",
      "u2 1 | mid v",
      "a3 1 | - ^",
      "u3 1 . last v",
      "a4 1 . - ^v",
      "c1 1 . - ^",
    ]);
  });

  it("three branches", () => {
    const model = buildTreeModel(
      [user("r", null, "r"), user("b1", "r", "1"), user("b2", "r", "2"), user("b3", "r", "3")],
      "b1",
    );
    expect(gutter(model)).toEqual(["r 0 - - v", "b1 1 | mid -", "b2 1 | mid -", "b3 1 . last -"]);
  });

  it("nested branch points keep the outer branch's line", () => {
    const model = buildTreeModel(
      [
        user("r", null, "r"),
        user("b1", "r", "b1"),
        user("b2", "r", "b2"),
        user("c1", "b1", "c1"),
        user("c2", "b1", "c2"),
        user("d", "c2", "d"),
      ],
      "d",
    );
    expect(gutter(model)).toEqual([
      "r 0 - - v",
      "b1 1 | mid v",
      "c1 2 || mid -",
      "c2 2 |. last v",
      "d 2 |. - ^",
      "b2 1 . last -",
    ]);
  });

  it("several roots are branches of a virtual root", () => {
    const model = buildTreeModel(
      [user("r1", null, "r1"), user("x", "r1", "x"), user("r2", null, "r2")],
      "x",
    );
    // The first root's elbow (┌) has nothing above it.
    expect(gutter(model)).toEqual(["r1 1 | first v", "x 1 | - ^", "r2 1 . last -"]);
  });

  it("several roots start at ARIA level 1", async () => {
    const entries = [user("r1", null, "r1"), user("x", "r1", "x"), user("r2", null, "r2")];
    await renderWithStore(<TreeView />, hydratedStore({ transcript: { entries, leafId: "x" } }));
    await screen.findAllByTestId("tree-row");
    expect(rows().map((r) => r.getAttribute("aria-level"))).toEqual(["1", "1", "1"]);
  });

  it("a collapsed branch point hides its branches and links nothing down", () => {
    const { entries, leafId } = sampleTree();
    expect(gutter(buildTreeModel(entries, leafId), ["a1"])).toEqual(["u1 0 - - v", "a1 0 - - ^"]);
  });
});

describe("TreeScreen", () => {
  it("renders user / assistant entries, markers, labels and the current leaf", async () => {
    stubFetch(handler());
    await renderTree();
    expect(rows().map((r) => r.dataset.entryId)).toEqual([
      "u1",
      "a1",
      "u2",
      "a3",
      "u3",
      "a4",
      "c1",
    ]);
    expect(screen.queryByText("ok")).toBeNull();
    expect(row("u2")).toHaveTextContent("checkpoint");
    expect(row("a3")).toHaveAttribute("data-current", "true");
    expect(within(row("a3")).getByText("current")).toBeInTheDocument();
    expect(row("c1")).toHaveTextContent("Context compacted (12k tokens)");
  });

  it("follows the store: new entries, labels and leaf moves update the tree without fetching", async () => {
    const { calls } = stubFetch(handler());
    const { store } = await renderTree();
    act(() => {
      store.setState((s) => ({
        transcript: {
          entries: [
            ...s.transcript.entries,
            user("u4", "a3", "One more thing"),
            label("l3", "u2", undefined),
            label("l4", "u4", "latest"),
          ],
          leafId: "u4",
        },
      }));
    });
    expect(row("u4")).toHaveAttribute("data-current", "true");
    expect(row("u4")).toHaveTextContent("latest");
    expect(row("u2")).not.toHaveTextContent("checkpoint");
    expect(calls.filter((c) => c.url === "/api/agents/a1/rpc")).toEqual([]);
  });

  it("collapses and expands a branch point", async () => {
    stubFetch(handler());
    const u = userEvent.setup();
    await renderTree();
    await u.click(within(row("a1")).getByRole("button", { name: "Collapse branches" }));
    expect(rows().map((r) => r.dataset.entryId)).toEqual(["u1", "a1"]);
    expect(row("a1")).toHaveTextContent("2 branches hidden");
    expect(row("a1")).toHaveAttribute("aria-expanded", "false");
    await u.click(within(row("a1")).getByRole("button", { name: "Expand branches" }));
    expect(rows()).toHaveLength(7);
  });

  it("collapsed branch points survive remounting the view", async () => {
    stubFetch(handler());
    const u = userEvent.setup();
    const { store, unmount } = await renderTree();
    await u.click(within(row("a1")).getByRole("button", { name: "Collapse branches" }));
    unmount();
    const again = await renderWithStore(<TreeScreen />, store);
    await again.router.navigate({ to: "/agents/$agentId/tree", params: { agentId: "a1" } });
    await screen.findAllByTestId("tree-row");
    expect(rows().map((r) => r.dataset.entryId)).toEqual(["u1", "a1"]);
    // Kept for the tab's lifetime only.
    expect(localStorage.getItem("pi-code:review") ?? "").not.toContain("collapsed");
    expect(useReviewStore.getState().reviews.a1?.tree.collapsed).toEqual(["a1"]);
  });

  it("is an ARIA tree with one tab stop, on the current row at first", async () => {
    stubFetch(handler());
    await renderTree();
    expect(screen.getByRole("tree", { name: "Session tree" })).toBeInTheDocument();
    expect(screen.getAllByRole("treeitem")).toHaveLength(7);
    expect(row("a3")).toHaveAttribute("aria-selected", "true");
    expect(rows().filter((r) => r.tabIndex === 0)).toEqual([row("a3")]);
    expect(row("a1")).toHaveAttribute("aria-expanded", "true");
    expect(row("u1")).not.toHaveAttribute("aria-expanded");
    expect(row("u2")).toHaveAttribute("aria-level", "2");
  });

  it("names each row by its preview, label and current badge only", async () => {
    stubFetch(handler());
    const u = userEvent.setup();
    await renderTree();
    await u.click(within(row("u2")).getByText("Go with plan A"));
    expect(screen.getByRole("treeitem", { name: "Go with plan A checkpoint" })).toBe(row("u2"));
    expect(screen.getByRole("treeitem", { name: "Plan A done current" })).toBe(row("a3"));
    expect(screen.getByRole("treeitem", { name: "Sure, plan below" })).toBe(row("a1"));
  });

  it("refreshes relative times every minute", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const recent = user("u1", null, "Hello");
      const store = hydratedStore({
        transcript: {
          entries: [{ ...recent, timestamp: new Date(Date.now() - 10_000).toISOString() }],
          leafId: "u1",
        },
      });
      await renderWithStore(<TreeView />, store);
      expect(
        await within(await screen.findByTestId("tree-row")).findByText("just now"),
      ).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(RELATIVE_TIME_TICK_MS));
      expect(within(row("u1")).getByText("1m ago")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("selecting a row keeps its actions inside it", async () => {
    stubFetch(handler());
    const u = userEvent.setup();
    await renderTree();
    await u.click(within(row("u3")).getByText("Try plan B instead"));
    expect(screen.getAllByRole("treeitem")).toHaveLength(7);
    expect(rows().map((r) => r.getAttribute("aria-selected"))).toEqual(
      ["u1", "a1", "u2", "a3", "u3", "a4", "c1"].map((id) => String(id === "u3")),
    );
    expect(row("u3").tabIndex).toBe(0);
    expect(document.activeElement).toBe(row("u3"));
    const goHere = within(row("u3")).getByRole("button", { name: "Go here" });
    expect(goHere.closest('[role="treeitem"]')).toBe(row("u3"));
  });

  it("keyboard: arrows move and collapse / expand, Home / End, Enter opens Go here", async () => {
    stubFetch(handler());
    const u = userEvent.setup();
    await renderTree();
    act(() => row("a3").focus());
    const focused = () => (document.activeElement as HTMLElement).dataset.entryId;
    const selected = () =>
      rows().find((r) => r.getAttribute("aria-selected") === "true")?.dataset.entryId;

    await u.keyboard("{ArrowUp}");
    expect([focused(), selected()]).toEqual(["u2", "u2"]);
    // Left from a branch's row goes to its branch point; left again collapses it.
    await u.keyboard("{ArrowLeft}");
    expect(focused()).toBe("a1");
    await u.keyboard("{ArrowLeft}");
    expect(rows().map((r) => r.dataset.entryId)).toEqual(["u1", "a1"]);
    // Right expands, then moves down.
    await u.keyboard("{ArrowRight}");
    expect(rows()).toHaveLength(7);
    expect(focused()).toBe("a1");
    await u.keyboard("{ArrowRight}");
    expect(focused()).toBe("u2");
    await u.keyboard("{End}");
    expect(focused()).toBe("c1");
    await u.keyboard("{Home}");
    expect(focused()).toBe("u1");
    await u.keyboard("{ArrowUp}");
    expect(focused()).toBe("u1");

    // Enter on the current row does nothing; on another it opens the confirmation.
    act(() => row("a3").focus());
    await u.keyboard("{Enter}");
    expect(screen.queryByTestId("navigate-sheet")).toBeNull();
    await u.keyboard("{ArrowDown}{Enter}");
    const sheet = await screen.findByTestId("navigate-sheet");
    expect(within(sheet).getByText("Try plan B instead")).toBeInTheDocument();
  });

  it("confirms Go here in a centered dialog on desktop", async () => {
    stubMatchMedia(() => true);
    stubFetch(handler());
    const u = userEvent.setup();
    await renderWithStore(<TreeView />, sampleStore());
    await screen.findAllByTestId("tree-row");
    await u.click(within(row("u3")).getByRole("button", { name: "Go here" }));
    const dialog = await screen.findByTestId("navigate-sheet");
    expect(dialog).toHaveAttribute("data-slot", "dialog-content");
    expect(within(dialog).getByRole("checkbox")).toBeInTheDocument();
  });

  it("keeps a valid selection when the selected row goes away", async () => {
    stubFetch(handler());
    const u = userEvent.setup();
    const { store } = await renderTree();
    await u.click(within(row("u2")).getByText("Go with plan A"));
    await u.click(within(row("a1")).getByRole("button", { name: "Collapse branches" }));
    // The chevron's click reaches its row, which selects the branch point.
    expect(selectedRows()).toEqual(["a1"]);
    expect(rows().filter((r) => r.tabIndex === 0)).toEqual([row("a1")]);
    await u.click(within(row("a1")).getByRole("button", { name: "Expand branches" }));
    act(() => {
      store.setState((s) => ({
        transcript: { entries: [...s.transcript.entries, user("u4", "a4", "Next")], leafId: "u4" },
      }));
    });
    // A leaf move keeps a visible selection.
    expect(selectedRows()).toEqual(["a1"]);
  });

  it("a hidden selected row hands selection and focus to the current row's nearest visible ancestor", async () => {
    stubFetch(handler());
    const u = userEvent.setup();
    await renderTree();
    await u.click(within(row("u2")).getByText("Go with plan A"));
    expect(document.activeElement).toBe(row("u2"));
    act(() => useReviewStore.getState().toggleTreeBranch("a1", "a1"));
    expect(rows().map((r) => r.dataset.entryId)).toEqual(["u1", "a1"]);
    expect(selectedRows()).toEqual(["a1"]);
    expect(document.activeElement).toBe(row("a1"));
  });

  it("scrolls to the current row's nearest visible ancestor when a collapse hides it", async () => {
    const scrolled: string[] = [];
    const scrollIntoView = vi.fn(function (this: HTMLElement) {
      scrolled.push(this.dataset.entryId ?? "");
    });
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      stubFetch(handler());
      useReviewStore.getState().toggleTreeBranch("a1", "a1");
      await renderTree();
      expect(selectedRows()).toEqual(["a1"]);
      expect(scrolled).toEqual(["a1"]);
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
  });

  it("Go here: summary choice + instructions → POST /tree/navigate, then back to the conversation", async () => {
    const { calls } = stubFetch(handler());
    const u = userEvent.setup();
    const { router } = await renderTree();
    await u.click(within(row("u3")).getByText("Try plan B instead"));
    await u.click(within(row("u3")).getByRole("button", { name: /Go here/ }));
    const sheet = await screen.findByTestId("navigate-sheet");
    await u.click(within(sheet).getByRole("checkbox"));
    await u.type(within(sheet).getByLabelText("Summary instructions (optional)"), "short");
    await u.click(within(sheet).getByRole("button", { name: /Go here/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === "/api/agents/a1/tree/navigate")?.body).toEqual({
        entryId: "u3",
        summarize: true,
        customInstructions: "short",
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a1"));
  });

  it("Go here without a summary, and a toast when cancelled", async () => {
    const { calls } = stubFetch(handler({ cancelled: true }));
    const u = userEvent.setup();
    const { router } = await renderTree();
    await u.click(within(row("a4")).getByText("Plan B done"));
    await u.click(within(row("a4")).getByRole("button", { name: /Go here/ }));
    const sheet = await screen.findByTestId("navigate-sheet");
    await u.click(within(sheet).getByRole("button", { name: /Go here/ }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Navigation cancelled"));
    expect(calls.find((c) => c.url === "/api/agents/a1/tree/navigate")?.body).toEqual({
      entryId: "a4",
      summarize: false,
    });
    expect(router.state.location.pathname).toBe("/agents/a1/tree");
  });

  /** Opens Go here on u3 and confirms it, with or without a summary. */
  async function confirmGoHere(summarize: boolean) {
    const u = userEvent.setup();
    await u.click(within(row("u3")).getByText("Try plan B instead"));
    await u.click(within(row("u3")).getByRole("button", { name: /Go here/ }));
    const sheet = await screen.findByTestId("navigate-sheet");
    if (summarize) await u.click(within(sheet).getByRole("checkbox"));
    await u.click(within(sheet).getByRole("button", { name: /Go here/ }));
    return { u, sheet };
  }

  it("shows Moving… while navigating without a summary; no seq → back right away", async () => {
    const pending = pendingNavigate();
    stubFetch(pending.handler);
    const { router } = await renderTree();
    const { u, sheet } = await confirmGoHere(false);
    expect(await within(sheet).findByRole("button", { name: /Moving…/ })).toBeDisabled();
    expect(within(sheet).queryByTestId("navigate-progress")).toBeNull();
    await u.keyboard("{Escape}");
    expect(screen.getByTestId("navigate-sheet")).toBeInTheDocument();
    pending.respond({ cancelled: false });
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a1"));
  });

  /**
   * Yields to real macrotasks (only `setTimeout` / `clearTimeout` are faked) until Go here's wait
   * for the store has scheduled its timeout, without advancing fake time.
   */
  async function untilSyncTimerPending() {
    for (let i = 0; i < 50 && vi.getTimerCount() === 0; i++) {
      await act(() => new Promise<void>((resolve) => setImmediate(resolve)));
    }
    expect(vi.getTimerCount()).toBe(1);
  }

  it("shows Summarizing… and the progress line, and waits for the store to reach seq", async () => {
    const pending = pendingNavigate();
    stubFetch(pending.handler);
    const { router, store } = await renderTree();
    const { sheet } = await confirmGoHere(true);
    expect(await within(sheet).findByRole("button", { name: /Summarizing…/ })).toBeDisabled();
    expect(within(sheet).getByTestId("navigate-progress")).toHaveTextContent(
      "Summarizing the branch you're leaving — this can take a while.",
    );
    // Leaving a3 for u3 with a summary: pi's new leaf is a branch summary under u3's parent.
    const summary = entry("s1", "a1", {
      type: "branch_summary",
      fromId: "a3",
      summary: "Plan A, summarized",
    });
    const seq = store.getState().seq + 1;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      pending.respond({ cancelled: false, leafId: "s1", seq });
      await untilSyncTimerPending();
      expect(router.state.location.pathname).toBe("/agents/a1/tree");
      act(() =>
        store.getState().apply({ type: "entries_appended", entries: [summary], leafId: "s1" }, seq),
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(store.getState().transcript.leafId).toBe("s1");
      expect(row("s1")).toHaveAttribute("data-current", "true");
      expect(row("a3")).not.toHaveAttribute("data-current", "true");
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a1"));
  });

  it("goes back after 1.5 s when the store never reaches seq", async () => {
    const pending = pendingNavigate();
    stubFetch(pending.handler);
    const { router, store } = await renderTree();
    await confirmGoHere(false);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Without a summary, going to u3 lands on its parent a1.
      pending.respond({ cancelled: false, leafId: "a1", seq: store.getState().seq + 5 });
      await untilSyncTimerPending();
      await act(async () => vi.advanceTimersByTime(1499));
      expect(screen.getByTestId("navigate-sheet")).toBeInTheDocument();
      expect(router.state.location.pathname).toBe("/agents/a1/tree");
      await act(async () => vi.advanceTimersByTime(1));
      expect(screen.queryByTestId("navigate-sheet")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a1"));
  });

  it("doesn't go back once the tree is gone", async () => {
    const pending = pendingNavigate();
    stubFetch(pending.handler);
    const { router, store, unmount } = await renderTree();
    await confirmGoHere(false);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      pending.respond({ cancelled: false, leafId: "a1", seq: store.getState().seq + 5 });
      await untilSyncTimerPending();
      unmount();
      await act(async () => vi.advanceTimersByTime(1500));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.state.location.pathname).toBe("/agents/a1/tree");
  });

  it("Fork from here (user messages only) → fork", async () => {
    const { calls } = stubFetch(handler());
    const u = userEvent.setup();
    const { router } = await renderTree();
    await u.click(within(row("a1")).getByText("Sure, plan below"));
    expect(within(row("a1")).queryByRole("button", { name: /Fork from here/ })).toBeNull();
    await u.click(within(row("u3")).getByText("Try plan B instead"));
    await u.click(within(row("u3")).getByRole("button", { name: /Fork from here/ }));
    await waitFor(() => expect(rpcBodies(calls)).toContainEqual({ type: "fork", entryId: "u3" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a1"));
    expect(useDrafts.getState().drafts.a1?.text).toBe("Try plan B instead");
  });

  it("the current leaf can't be navigated to", async () => {
    stubFetch(handler());
    const u = userEvent.setup();
    await renderTree();
    await u.click(within(row("a3")).getByText("Plan A done"));
    expect(within(row("a3")).getByRole("button", { name: /Go here/ })).toBeDisabled();
  });

  it("actions are disabled while a run is active", async () => {
    stubFetch(handler());
    const u = userEvent.setup();
    await renderTree(true);
    expect(screen.getByTestId("tree-running")).toBeInTheDocument();
    await u.click(within(row("u3")).getByText("Try plan B instead"));
    expect(within(row("u3")).getByRole("button", { name: /Go here/ })).toBeDisabled();
    expect(within(row("u3")).getByRole("button", { name: /Fork from here/ })).toBeDisabled();
  });
  it("has no Go here or Fork from here for a conversation attached to a PR", async () => {
    stubFetch(handler());
    const u = userEvent.setup();
    const { entries, leafId } = sampleTree();
    const store = hydratedStore({
      agent: makeAgent({ sessionFile: "/s/a1.jsonl" }),
      transcript: { entries, leafId },
    });
    const { registry } = await renderWithStore(<TreeView />, store);
    act(() => registry.live.setState({ prs: { "/s/a1.jsonl": makePr() } }));
    await u.click(within(row("u3")).getByText("Try plan B instead"));
    expect(within(row("u3")).queryByRole("button", { name: /Go here/ })).toBeNull();
    expect(within(row("u3")).queryByRole("button", { name: /Fork from here/ })).toBeNull();
    // With no actions to swap in, the selected row keeps its timestamp.
    expect(row("u3").querySelector("time")).not.toHaveClass("group-aria-selected/row:invisible");
    await u.keyboard("{Enter}");
    expect(screen.queryByTestId("navigate-sheet")).toBeNull();
  });
});
