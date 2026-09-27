import { initialLiveState, type SessionEntry, type SessionTreeNode } from "@pi-code/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationUi } from "@/features/conversation/conversation-ui";
import { type FetchCall, hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import { buildTreeModel, flattenTree } from "./tree-model";
import { MAX_INDENT, TreeScreen } from "./tree-screen";

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

function node(e: SessionEntry, children: SessionTreeNode[] = [], label?: string): SessionTreeNode {
  return { entry: e, children, ...(label ? { label } : {}) };
}

/**
 * u1 → a1 ─┬→ u2 [label "checkpoint"] → a2 (tool only) → tr → a3 (leaf)
 *          └→ u3 → a4
 *                   └→ compaction
 */
function sampleTree(): { tree: SessionTreeNode[]; leafId: string } {
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
    tree: [
      node(u1, [
        node(a1, [
          node(u2, [node(a2, [node(tr, [node(a3)])])], "checkpoint"),
          node(u3, [node(a4, [node(compaction)])]),
        ]),
      ]),
    ],
    leafId: "a3",
  };
}

const rpcBodies = (calls: FetchCall[]) =>
  calls.filter((c) => c.url === "/api/agents/a1/rpc").map((c) => c.body);

function handler(navigateResult: { cancelled: boolean } = { cancelled: false }) {
  return (call: FetchCall): [number, unknown] | undefined => {
    if (call.url === "/api/agents/a1/rpc") {
      const type = (call.body as { type: string }).type;
      if (type === "get_tree") return [200, { data: sampleTree() }];
      if (type === "fork") return [200, { data: { text: "Try plan B instead", cancelled: false } }];
    }
    if (call.url === "/api/agents/a1/tree/navigate") return [200, navigateResult];
    return undefined;
  };
}

async function renderTree(running = false) {
  const store = hydratedStore(
    running ? { live: { ...initialLiveState(), run: { active: true } } } : {},
  );
  const result = await renderWithStore(<TreeScreen />, store);
  await result.router.navigate({ to: "/agents/$agentId/tree", params: { agentId: "a1" } });
  await screen.findAllByTestId("tree-row");
  return result;
}

const rows = () => screen.getAllByTestId("tree-row");
const row = (id: string) =>
  rows().find((r) => r.dataset.entryId === id) ?? (null as unknown as HTMLElement);

beforeEach(() => {
  useConversationUi.getState().reset();
  vi.mocked(toast.info).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tree model", () => {
  it("hides tool traffic, keeps markers, indents only at branch points", () => {
    const { tree, leafId } = sampleTree();
    const model = buildTreeModel(tree, leafId);
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
    expect(model.items.get("c1")?.text).toBe("Context compacted (12,345 tokens)");
    // Collapsing a branch point hides its subtree.
    expect(flattenTree(model, new Set(["a1"])).map((r) => r.item.id)).toEqual(["u1", "a1"]);
  });

  it("maps a hidden leaf to its nearest shown ancestor", () => {
    const { tree } = sampleTree();
    expect(buildTreeModel(tree, "tr").currentId).toBe("u2");
  });

  it("caps indentation depth", async () => {
    // A chain of nested branch points deeper than MAX_INDENT.
    let child: SessionTreeNode | undefined;
    for (let i = MAX_INDENT + 3; i >= 0; i--) {
      const u = user(`n${i}`, i === 0 ? null : `n${i - 1}`, `msg ${i}`);
      const sibling = node(user(`s${i}`, `n${i}`, `side ${i}`));
      child = node(u, child ? [child, sibling] : []);
    }
    stubFetch((call) =>
      call.url === "/api/agents/a1/rpc"
        ? [200, { data: { tree: [child], leafId: "n0" } }]
        : undefined,
    );
    await renderWithStore(<TreeScreen />, hydratedStore());
    await screen.findAllByTestId("tree-row");
    const deepest = rows().find((r) => r.dataset.entryId === `n${MAX_INDENT + 3}`);
    expect(Number(deepest?.dataset.depth)).toBeGreaterThan(MAX_INDENT);
    expect(deepest?.style.paddingLeft).toBe(`${MAX_INDENT * 14}px`);
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
    expect(row("c1")).toHaveTextContent("Context compacted (12,345 tokens)");
  });

  it("collapses and expands a branch point", async () => {
    stubFetch(handler());
    const u = userEvent.setup();
    await renderTree();
    await u.click(within(row("a1")).getByRole("button", { name: "Collapse branches" }));
    expect(rows().map((r) => r.dataset.entryId)).toEqual(["u1", "a1"]);
    expect(row("a1")).toHaveTextContent("2 branches");
    await u.click(within(row("a1")).getByRole("button", { name: "Expand branches" }));
    expect(rows()).toHaveLength(7);
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
    expect(useConversationUi.getState().draft?.text).toBe("Try plan B instead");
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
});
