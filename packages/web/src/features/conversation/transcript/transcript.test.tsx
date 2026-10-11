import { activeBranch, initialLiveState, type SessionEntry } from "@pi-code/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useUiPrefs } from "@/store/ui-prefs";
import { fixtureEvents, fixtureNames, fixtureTranscript, makeAgent } from "@/test/fixtures";
import { hydratedStore, renderWithStore } from "@/test/render";
import { LiveSection } from "./live-section";
import { Transcript } from "./transcript";

function count(branch: SessionEntry[], predicate: (entry: SessionEntry) => boolean): number {
  return branch.filter(predicate).length;
}

const isRole = (role: string) => (e: SessionEntry) =>
  e.type === "message" && e.message.role === role;

async function renderTranscript(name: string) {
  const transcript = fixtureTranscript(name);
  const store = hydratedStore({ agent: makeAgent(), transcript });
  await renderWithStore(<Transcript />, store);
  return { transcript, branch: activeBranch(transcript) };
}

beforeEach(() => {
  useUiPrefs.setState({ density: "balanced" });
});

describe.each(fixtureNames())("transcript of fixture %s", (name) => {
  // Detailed: no exploration group hides a call in its collapsed body.
  beforeEach(() => {
    useUiPrefs.setState({ density: "detailed" });
  });

  it("renders every visible entry of the active branch", async () => {
    const { branch } = await renderTranscript(name);
    const root = await screen.findByTestId("transcript");

    expect(within(root).queryAllByTestId("user-message")).toHaveLength(
      count(branch, isRole("user")),
    );
    const texts = branch.flatMap((e) =>
      e.type === "message" && e.message.role === "assistant"
        ? e.message.content.filter((c) => c.type === "text" && c.text.trim() !== "")
        : [],
    );
    expect(within(root).queryAllByTestId("assistant-text")).toHaveLength(texts.length);
    // A turn per user message, plus one for what comes before the first.
    const users = count(branch, isRole("user"));
    const turns = within(root).queryAllByTestId("turn");
    expect(turns.length === users || turns.length === users + 1).toBe(true);
    expect(within(root).queryAllByTestId("bash-execution")).toHaveLength(
      count(branch, isRole("bashExecution")),
    );
    const toolCalls = branch.flatMap((e) =>
      e.type === "message" && e.message.role === "assistant"
        ? e.message.content.filter((c) => c.type === "toolCall")
        : [],
    );
    expect(within(root).queryAllByTestId("tool-call")).toHaveLength(toolCalls.length);
    expect(within(root).queryAllByTestId("model-change")).toHaveLength(
      count(branch, (e) => e.type === "model_change"),
    );
    expect(within(root).queryAllByTestId("thinking-change")).toHaveLength(
      count(branch, (e) => e.type === "thinking_level_change"),
    );
    expect(within(root).queryAllByTestId("compaction")).toHaveLength(
      count(branch, (e) => e.type === "compaction"),
    );
    expect(within(root).queryAllByTestId("branch-summary")).toHaveLength(
      count(branch, (e) => e.type === "branch_summary"),
    );
    expect(within(root).queryAllByTestId("custom-message")).toHaveLength(
      count(branch, (e) => e.type === "custom_message" && e.display),
    );
  });

  it("pairs every tool call with its committed result", async () => {
    const { branch } = await renderTranscript(name);
    const results = new Map<string, boolean>();
    for (const e of branch) {
      if (e.type === "message" && e.message.role === "toolResult") {
        results.set(e.message.toolCallId, e.message.isError);
      }
    }
    for (const el of screen.queryAllByTestId("tool-call")) {
      expect(["done", "error"]).toContain(el.dataset.status);
    }
    expect(
      screen.queryAllByTestId("tool-call").filter((el) => el.dataset.status === "error"),
    ).toHaveLength([...results.values()].filter(Boolean).length);
  });
});

describe("transcript rendering details", () => {
  it("hides the system message and shows no raw entries for hidden kinds", async () => {
    const { branch } = await renderTranscript("entry-types");
    const system = branch.find(isRole("system"));
    expect(system).toBeDefined();
    expect(document.querySelector(`[data-entry-id="${system?.id}"]`)).toBeNull();
    for (const e of branch.filter((x) => ["custom", "session_info", "label"].includes(x.type))) {
      expect(document.querySelector(`[data-entry-id="${e.id}"]`)).toBeNull();
    }
  });

  it("shows labels as badges on their target entries", async () => {
    const transcript = fixtureTranscript("entry-types");
    const branch = activeBranch(transcript);
    const labels = new Map<string, string>();
    for (const e of transcript.entries) {
      if (e.type === "label") {
        if (e.label) labels.set(e.targetId, e.label);
        else labels.delete(e.targetId);
      }
    }
    await renderWithStore(<Transcript />, hydratedStore({ transcript }));
    const onBranch = [...labels].filter(([id]) =>
      branch.some((e) => e.id === id && document.querySelector(`[data-entry-id="${id}"]`)),
    );
    expect(onBranch.length).toBeGreaterThan(0);
    for (const [id, label] of onBranch) {
      const el = document.querySelector(`[data-entry-id="${id}"]`) as HTMLElement;
      expect(within(el).getByTestId("entry-label")).toHaveTextContent(label);
    }
  });

  it("renders compaction and branch summary dividers with their summaries", async () => {
    await renderTranscript("compaction");
    const divider = screen.getByTestId("compaction");
    expect(divider).toHaveTextContent(/Context compacted \([\d.]+[kM]? tokens\)/);
    // The summary renders only once expanded.
    expect(divider.querySelector(".markdown")).toBeNull();
    await userEvent.setup().click(within(divider).getByText(/Context compacted/));
    await waitFor(() => expect(divider.querySelector(".markdown")).not.toBeNull());
    await renderTranscript("entry-types");
    expect(screen.getByTestId("branch-summary")).toHaveTextContent("Branch summary");
  });

  it("shows aborted runs as Stopped (including pi's abort-mid-tool error turn)", async () => {
    const { branch } = await renderTranscript("abort");
    const assistants = branch.filter(isRole("assistant"));
    expect(assistants.length).toBeGreaterThan(0);
    // abort during text → "aborted"; abort mid-tool → stopReason error "This operation was aborted".
    expect(screen.getAllByTestId("assistant-aborted")).toHaveLength(2);
    expect(screen.queryByTestId("assistant-error")).toBeNull();
    expect(screen.getAllByTestId("tool-call")[0]).toHaveAttribute("data-status", "error");
  });

  it("marks !! bash executions as excluded from context and shows non-zero exit codes", async () => {
    await renderTranscript("bash-command");
    const runs = screen.getAllByTestId("bash-execution");
    expect(runs.some((el) => el.dataset.excluded === "true")).toBe(true);
    expect(screen.getByText("exit 3")).toBeInTheDocument();
    expect(screen.queryByText("exit 0")).toBeNull();
  });

  it("renders user text from array content and image thumbnails", async () => {
    const transcript = {
      entries: [
        {
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            role: "user",
            content: [
              { type: "text", text: "look at this" },
              { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
            ],
            timestamp: 0,
          },
        },
      ] as SessionEntry[],
      leafId: "u1",
    };
    await renderWithStore(<Transcript />, hydratedStore({ transcript }));
    expect(screen.getByText("look at this")).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
  });

  it("shows assistant errors and collapsed thinking", async () => {
    const transcript = {
      entries: [
        {
          type: "message",
          id: "a1",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "pondering" },
              { type: "text", text: "partial **answer**" },
            ],
            stopReason: "error",
            errorMessage: "overloaded_error",
            api: "anthropic-messages",
            provider: "anthropic",
            model: "m",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
            timestamp: 0,
          },
        },
      ] as unknown as SessionEntry[],
      leafId: "a1",
    };
    await renderWithStore(<Transcript />, hydratedStore({ transcript }));
    expect(screen.getByTestId("assistant-error")).toHaveTextContent("overloaded_error");
    expect(within(screen.getByTestId("thinking")).getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText("answer").tagName).toMatch(/STRONG|SPAN/);
  });
});

describe("thinking durations end to end", () => {
  it("a committed block reads the duration the reducer recorded while it streamed", async () => {
    const store = hydratedStore({ agent: makeAgent() });
    fixtureEvents("plain-answer").forEach((event, index) => {
      store.getState().apply(event, index + 1);
    });
    expect(store.getState().live.streaming).toBeUndefined();
    expect(Object.keys(store.getState().live.thinkingMs)).toHaveLength(1);
    await renderWithStore(<Transcript />, store);
    expect(screen.getByTestId("thinking")).toHaveTextContent(/^Thoughtfor \d+s$/);
  });
});

describe("the live turn", () => {
  it("appends streaming blocks to the last turn; a pending user message starts a new one", async () => {
    const transcript = fixtureTranscript("plain-answer");
    const store = hydratedStore({ agent: makeAgent(), transcript });
    await renderWithStore(<Transcript />, store);
    expect(screen.queryByTestId("live-turn")).toBeNull();
    const committed = screen.getAllByTestId("turn").at(-1) as HTMLElement;
    expect(within(committed).getAllByTestId("assistant-text")).toHaveLength(1);

    act(() => {
      store.setState((s) => ({
        live: {
          ...s.live,
          run: { active: true },
          streaming: {
            timestamp: 99,
            blocks: {
              0: { type: "thinking", text: "still thinking", done: false },
              1: { type: "text", text: "more to say", done: false },
            },
          },
        },
      }));
    });
    const live = screen.getByTestId("live-turn");
    // The last committed turn continues with the streaming blocks.
    expect(within(live).getAllByTestId("user-message")).toHaveLength(1);
    expect(within(live).getAllByTestId("assistant-text")).toHaveLength(2);
    expect(within(live).getByText("more to say")).toBeInTheDocument();
    expect(
      within(within(live).getAllByTestId("thinking").at(-1) as HTMLElement).getByText("Thinking"),
    ).toHaveClass("shimmer");

    act(() => {
      store.setState((s) => ({
        live: {
          ...s.live,
          streaming: undefined,
          pendingUser: { role: "user", content: "and another thing", timestamp: 100 },
        },
      }));
    });
    const turns = screen.getAllByTestId(/^(live-)?turn$/);
    const pending = turns.at(-1) as HTMLElement;
    expect(pending).toHaveAttribute("data-testid", "live-turn");
    expect(within(pending).getByTestId("user-message")).toHaveTextContent("and another thing");
    expect(within(pending).getByTestId("user-message")).toHaveClass("opacity-70");
    expect(turns.at(-2)).toHaveAttribute("data-testid", "turn");
    expect(screen.queryByText("more to say")).toBeNull();
  });

  it("shows running tools with no committed or streaming call (after a reload)", async () => {
    const store = hydratedStore({
      transcript: fixtureTranscript("plain-answer"),
      live: {
        ...initialLiveState(),
        run: { active: true },
        tools: { t9: { toolName: "bash", args: { command: "sleep 9" }, status: "running" } },
      },
    });
    await renderWithStore(<Transcript />, store);
    const live = screen.getByTestId("live-turn");
    expect(within(live).getByTestId("tool-call")).toHaveAttribute("data-status", "running");
  });

  it("leaves calls unanswered in an earlier turn done during a later run", async () => {
    const entry = (id: string, parentId: string | null, message: unknown) =>
      ({
        type: "message",
        id,
        parentId,
        timestamp: "2026-01-01T00:00:00.000Z",
        message,
      }) as unknown as SessionEntry;
    const read = (id: string, path: string) => ({
      type: "toolCall",
      id,
      name: "read",
      arguments: { path },
    });
    const transcript = {
      entries: [
        entry("u1", null, { role: "user", content: "look", timestamp: 0 }),
        entry("a1", "u1", {
          role: "assistant",
          content: [read("old", "src/old.ts"), read("older", "src/older.ts")],
          stopReason: "aborted",
          timestamp: 1,
        }),
        entry("u2", "a1", { role: "user", content: "again", timestamp: 2 }),
      ],
      leafId: "u2",
    };
    const live = {
      ...initialLiveState(),
      run: { active: true },
      streaming: {
        timestamp: 3,
        blocks: { 0: { type: "text" as const, text: "Hi", done: false } },
      },
    };
    const store = hydratedStore({ agent: makeAgent(), transcript, live });
    const ui = (
      <>
        <Transcript />
        <LiveSection />
      </>
    );

    useUiPrefs.setState({ density: "compact" });
    await renderWithStore(ui, store);
    expect(screen.getByTestId("live-status")).toHaveTextContent("Working");

    cleanup();
    useUiPrefs.setState({ density: "balanced" });
    await renderWithStore(ui, store);
    expect(screen.getByTestId("live-status")).toHaveTextContent("Working");
    const group = screen.getByTestId("exploration-group");
    expect(group).toHaveAttribute("data-status", "done");
    expect(group).toHaveTextContent("Explored");

    cleanup();
    useUiPrefs.setState({ density: "detailed" });
    await renderWithStore(ui, store);
    const rows = screen.getAllByTestId("tool-call");
    expect(rows.map((row) => row.dataset.status)).toEqual(["done", "done"]);
    for (const row of rows) {
      expect(row.querySelector('[data-slot="row-verb"]')).not.toHaveClass("shimmer");
    }
  });
});
