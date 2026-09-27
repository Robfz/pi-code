import { activeBranch, type SessionEntry } from "@pi-code/protocol";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fixtureNames, fixtureTranscript, makeAgent } from "@/test/fixtures";
import { hydratedStore, renderWithStore } from "@/test/render";
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

describe.each(fixtureNames())("transcript of fixture %s", (name) => {
  it("renders every visible entry of the active branch", async () => {
    const { branch } = await renderTranscript(name);
    const root = await screen.findByTestId("transcript");

    expect(within(root).queryAllByTestId("user-message")).toHaveLength(
      count(branch, isRole("user")),
    );
    expect(within(root).queryAllByTestId("assistant-message")).toHaveLength(
      count(branch, isRole("assistant")),
    );
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
    expect(screen.getByTestId("compaction")).toHaveTextContent(
      /Context compacted \([\d,]+ tokens\)/,
    );
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

  it("marks !! bash executions as excluded from context and shows exit codes", async () => {
    await renderTranscript("bash-command");
    const runs = screen.getAllByTestId("bash-execution");
    expect(runs.some((el) => el.dataset.excluded === "true")).toBe(true);
    expect(screen.getByText("exit 3")).toBeInTheDocument();
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
    expect(screen.getByTestId("thinking")).not.toHaveAttribute("open");
    expect(screen.getByText("answer").tagName).toMatch(/STRONG|SPAN/);
  });
});
