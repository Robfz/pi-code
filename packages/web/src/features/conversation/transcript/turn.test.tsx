import { initialLiveState, type LiveState, type SessionEntry } from "@pi-code/protocol";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatCost, formatSeconds } from "@/lib/time";
import type { ConversationStore } from "@/store/conversation-store";
import { selectTurns, turnStats } from "@/store/turns";
import { type Density, useUiPrefs } from "@/store/ui-prefs";
import { fixtureTranscript } from "@/test/fixtures";
import { hydratedStore, renderWithStore } from "@/test/render";
import { rowBody, rowParts } from "@/tools/testing";
import { Transcript } from "./transcript";

const groupRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./exploration-group", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exploration-group")>();
  return {
    ...actual,
    ExplorationGroupRow: (props: Parameters<typeof actual.ExplorationGroupRow>[0]) => {
      groupRenders.count++;
      return actual.ExplorationGroupRow(props);
    },
  };
});

async function renderFixture(name: string, density: Density, live: Partial<LiveState> = {}) {
  useUiPrefs.setState({ density });
  const store = hydratedStore({
    transcript: fixtureTranscript(name),
    live: { ...initialLiveState(), ...live },
  });
  await renderWithStore(<Transcript />, store);
  return store;
}

/** The fixture's user turn (the last one). */
const lastTurn = () => screen.getAllByTestId(/^(live-)?turn$/).at(-1) as HTMLElement;
const trigger = (row: HTMLElement) => row.firstElementChild as HTMLElement;
const expanded = (row: HTMLElement) => trigger(row).getAttribute("aria-expanded");

function lastTurnStats(store: ConversationStore) {
  const turn = selectTurns(store.getState()).at(-1);
  if (!turn) throw new Error("no turn");
  return turnStats(turn);
}

beforeEach(() => {
  useUiPrefs.setState({ density: "balanced" });
});

describe("TurnView in Compact", () => {
  it("folds a finished turn into 'Worked for …', then the final text", async () => {
    const store = await renderFixture("tool-calls", "compact");
    const turn = lastTurn();
    const worked = within(turn).getByTestId("worked");
    const { durationMs, finalText } = lastTurnStats(store);
    expect(durationMs).toBeGreaterThan(0);
    expect(rowParts(worked)).toMatchObject({
      icon: "list-checks",
      verb: `Worked for ${formatSeconds(durationMs ?? 0)}`,
    });
    expect(within(worked).getByText(/^Worked/)).toHaveClass("text-muted-foreground");
    expect(expanded(worked)).toBe("false");
    // Outside the row: the user message and the final text only.
    expect(within(turn).queryAllByTestId("tool-call")).toHaveLength(0);
    expect(within(turn).queryAllByTestId("thinking")).toHaveLength(0);
    const texts = within(turn).getAllByTestId("assistant-text");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toHaveTextContent(finalText?.slice(0, 20) ?? "");
    // The order: user message, "Worked" row, final text.
    expect(within(turn).getByTestId("user-message").compareDocumentPosition(worked)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(worked.compareDocumentPosition(texts[0] as HTMLElement)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("ends a finished turn with a footer without the duration", async () => {
    const store = await renderFixture("tool-calls", "compact");
    const { durationMs, cost } = lastTurnStats(store);
    const footer = within(lastTurn()).getByTestId("turn-footer");
    expect(footer).toHaveTextContent(formatCost(cost));
    expect(footer).not.toHaveTextContent(formatSeconds(durationMs ?? 0));
  });

  it("expands 'Worked' to the steps as Balanced shows them, exploration grouped", async () => {
    await renderFixture("tool-calls", "compact");
    const worked = within(lastTurn()).getByTestId("worked");
    await userEvent.setup().click(trigger(worked));
    const body = rowBody(worked);
    const rows = within(body).getAllByTestId("tool-call");
    expect(rows.map((row) => rowParts(row).verb)).toEqual(["Read", "Edited"]);
    expect(rows.map(expanded)).toEqual(["false", "false"]);
    expect(within(body).getAllByTestId("thinking")).toHaveLength(3);
    expect(within(body).queryAllByTestId("assistant-text")).toHaveLength(0);

    await renderFixture("parallel-tools", "compact");
    const parallel = within(lastTurn()).getByTestId("worked");
    await userEvent.setup().click(trigger(parallel));
    const group = within(rowBody(parallel)).getByTestId("exploration-group");
    expect(rowParts(group)).toMatchObject({ verb: "Explored", meta: "2 files" });
  });

  it("shows a live turn's streaming text alone", async () => {
    await renderFixture("tool-calls", "compact", {
      run: { active: true },
      streaming: {
        timestamp: 99,
        blocks: {
          0: { type: "thinking", text: "mulling", done: true },
          1: { type: "text", text: "Now checking the rest", done: false },
        },
      },
      tools: { t9: { toolName: "bash", args: { command: "pnpm test" }, status: "running" } },
    });
    const turn = screen.getByTestId("live-turn");
    expect(within(turn).getByTestId("user-message")).toBeInTheDocument();
    expect(within(turn).queryByTestId("worked")).toBeNull();
    expect(within(turn).queryAllByTestId("tool-call")).toHaveLength(0);
    expect(within(turn).queryAllByTestId("thinking")).toHaveLength(0);
    const texts = within(turn).getAllByTestId("assistant-text");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toHaveTextContent("Now checking the rest");
  });
});

describe("TurnView in Balanced", () => {
  it("expands a running bash row, collapsed once done", async () => {
    const store = await renderFixture("tool-calls", "balanced", {
      run: { active: true },
      tools: { t9: { toolName: "bash", args: { command: "pnpm test" }, status: "running" } },
    });
    const row = () =>
      within(screen.getByTestId("live-turn"))
        .getAllByTestId("tool-call")
        .find((el) => el.dataset.tool === "bash") as HTMLElement;
    expect(rowParts(row()).verb).toBe("Running");
    expect(expanded(row())).toBe("true");
    act(() => {
      store.setState((s) => ({
        live: {
          ...s.live,
          tools: {
            t9: { toolName: "bash", args: { command: "pnpm test" }, status: "done", result: {} },
          },
        },
      }));
    });
    expect(rowParts(row()).verb).toBe("Ran");
    expect(expanded(row())).toBe("false");
  });

  it("shows every step collapsed, exploration grouped", async () => {
    await renderFixture("parallel-tools", "balanced");
    const turn = lastTurn();
    expect(within(turn).getByTestId("exploration-group")).toBeInTheDocument();
    expect(within(turn).queryAllByTestId("tool-call")).toHaveLength(0);
    for (const row of within(turn).getAllByTestId("thinking")) expect(expanded(row)).toBe("false");
  });
});

describe("TurnView in Detailed", () => {
  it("has no group and expands every row and thinking", async () => {
    await renderFixture("parallel-tools", "detailed");
    expect(within(lastTurn()).queryByTestId("exploration-group")).toBeNull();
    expect(within(lastTurn()).getAllByTestId("tool-call")).toHaveLength(2);

    await renderFixture("tool-calls", "detailed");
    const turn = lastTurn();
    const rows = [
      ...within(turn).getAllByTestId("tool-call"),
      ...within(turn).getAllByTestId("thinking"),
    ];
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(expanded(row)).toBe("true");
  });
});

describe("local overrides", () => {
  it("keeps a toggled row until the density changes", async () => {
    await renderFixture("tool-calls", "balanced");
    const read = () =>
      within(lastTurn())
        .getAllByTestId("tool-call")
        .find((el) => el.dataset.tool === "read") as HTMLElement;
    const edit = () =>
      within(lastTurn())
        .getAllByTestId("tool-call")
        .find((el) => el.dataset.tool === "edit") as HTMLElement;
    await userEvent.setup().click(trigger(read()));
    expect(expanded(read())).toBe("true");
    expect(expanded(edit())).toBe("false");

    act(() => useUiPrefs.getState().setDensity("detailed"));
    expect(expanded(read())).toBe("true");
    expect(expanded(edit())).toBe("true");
    await userEvent.setup().click(trigger(read()));
    expect(expanded(read())).toBe("false");

    act(() => useUiPrefs.getState().setDensity("balanced"));
    expect(expanded(read())).toBe("false");
    expect(expanded(edit())).toBe("false");
    await userEvent.setup().click(trigger(edit()));
    act(() => useUiPrefs.getState().setDensity("detailed"));
    act(() => useUiPrefs.getState().setDensity("balanced"));
    expect(expanded(edit())).toBe("false");
  });
});

describe("TurnView's live steps", () => {
  const entry = (id: string, parentId: string | null, message: unknown) =>
    ({
      type: "message",
      id,
      parentId,
      timestamp: "2026-01-01T00:00:00.000Z",
      message,
    }) as unknown as SessionEntry;
  const read = (id: string, path: string) => ({
    type: "toolCall" as const,
    id,
    name: "read",
    arguments: { path },
  });
  const transcript = {
    entries: [
      entry("u1", null, { role: "user", content: "look", timestamp: 0 }),
      entry("a1", "u1", {
        role: "assistant",
        content: [{ type: "text", text: "Reading first." }, read("r1", "src/a.ts")],
        stopReason: "toolUse",
        timestamp: 1,
      }),
      entry("t1", "a1", {
        role: "toolResult",
        toolCallId: "r1",
        toolName: "read",
        content: [{ type: "text", text: "a" }],
        isError: false,
        timestamp: 2,
      }),
    ],
    leafId: "t1",
  };

  it("shows an entry committed in the same update as its live step once", async () => {
    const store = hydratedStore({
      transcript,
      live: {
        ...initialLiveState(),
        run: { active: true },
        // The committed message's blocks, still in the streaming state.
        streaming: {
          timestamp: 1,
          blocks: {
            0: { type: "text", text: "Reading first.", done: true },
            1: {
              type: "toolCall",
              id: "r1",
              name: "read",
              argsText: "",
              call: read("r1", "src/a.ts"),
            },
          },
        },
      },
    });
    useUiPrefs.setState({ density: "detailed" });
    await renderWithStore(<Transcript />, store);
    const turn = screen.getByTestId("live-turn");
    expect(within(turn).getAllByTestId("assistant-text")).toHaveLength(1);
    expect(within(turn).getAllByTestId("tool-call")).toHaveLength(1);
  });

  it("groups exploration calls across the committed steps and the live ones", async () => {
    const store = hydratedStore({
      transcript,
      live: {
        ...initialLiveState(),
        run: { active: true },
        streaming: {
          timestamp: 3,
          blocks: {
            0: {
              type: "toolCall",
              id: "r2",
              name: "read",
              argsText: "",
              call: read("r2", "src/b.ts"),
            },
          },
        },
      },
    });
    useUiPrefs.setState({ density: "balanced" });
    await renderWithStore(<Transcript />, store);
    const turn = screen.getByTestId("live-turn");
    const groups = within(turn).getAllByTestId("exploration-group");
    expect(groups).toHaveLength(1);
    await userEvent.setup().click(trigger(groups[0] as HTMLElement));
    const rows = within(rowBody(groups[0] as HTMLElement)).getAllByTestId("tool-call");
    expect(rows.map((row) => rowParts(row).target)).toEqual(["a.tssrc", "b.tssrc"]);
  });

  it("re-renders only the streaming step on a delta, not the committed group", async () => {
    const reads = {
      entries: [
        entry("u1", null, { role: "user", content: "look", timestamp: 0 }),
        entry("a1", "u1", {
          role: "assistant",
          content: [read("r1", "src/a.ts"), read("r2", "src/b.ts")],
          stopReason: "toolUse",
          timestamp: 1,
        }),
      ],
      leafId: "a1",
    };
    const text = (t: string) => ({ type: "text" as const, text: t, done: false });
    const store = hydratedStore({
      transcript: reads,
      live: {
        ...initialLiveState(),
        run: { active: true },
        streaming: { timestamp: 5, blocks: { 0: { ...text("Now"), done: true }, 1: text("A") } },
      },
    });
    useUiPrefs.setState({ density: "balanced" });
    await renderWithStore(<Transcript />, store);
    const turn = screen.getByTestId("live-turn");
    expect(within(turn).getByTestId("exploration-group")).toHaveTextContent("Exploring");
    const renders = groupRenders.count;
    for (const delta of ["AB", "ABC", "ABCD"]) {
      act(() => {
        store.setState((s) => {
          const streaming = s.live.streaming;
          if (!streaming) throw new Error("not streaming");
          const blocks = { ...streaming.blocks, 1: text(delta) };
          return { live: { ...s.live, streaming: { ...streaming, blocks } } };
        });
      });
    }
    expect(within(turn).getAllByTestId("assistant-text").at(-1)).toHaveTextContent("ABCD");
    expect(groupRenders.count).toBe(renders);
  });

  it("keeps a streamed text's DOM through its end and its commit", async () => {
    const body = "Look at @src/a.ts:3.\n\nThen more";
    const streaming = (done: boolean) => ({
      timestamp: 3,
      blocks: { 0: { type: "text" as const, text: body, done } },
    });
    const store = hydratedStore({
      transcript,
      live: { ...initialLiveState(), run: { active: true }, streaming: streaming(false) },
    });
    await renderWithStore(<Transcript />, store);
    const paragraph = () => within(screen.getByTestId("live-turn")).getByText(/^Look at/);
    const first = paragraph();

    act(() => store.setState((s) => ({ live: { ...s.live, streaming: streaming(true) } })));
    expect(paragraph()).toBe(first);
    expect(first.querySelector("[data-code-ref]")).toHaveTextContent("@src/a.ts:3");

    const committed = entry("a2", "t1", {
      role: "assistant",
      content: [{ type: "text", text: body }],
      stopReason: "stop",
      timestamp: 3,
    });
    act(() =>
      store.setState((s) => ({
        transcript: { entries: [...transcript.entries, committed], leafId: "a2" },
        live: { ...s.live, streaming: undefined },
      })),
    );
    expect(paragraph()).toBe(first);
    expect(within(screen.getByTestId("live-turn")).getAllByText(/^Look at/)).toHaveLength(1);
  });
});
