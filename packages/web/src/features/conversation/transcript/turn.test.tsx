import { initialLiveState, type LiveState } from "@pi-code/protocol";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { formatSeconds } from "@/lib/time";
import type { ConversationStore } from "@/store/conversation-store";
import { selectTurns, turnStats } from "@/store/turns";
import { type Density, useUiPrefs } from "@/store/ui-prefs";
import { fixtureTranscript } from "@/test/fixtures";
import { hydratedStore, renderWithStore } from "@/test/render";
import { rowBody, rowParts } from "@/tools/testing";
import { Transcript } from "./transcript";

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
