import { initialLiveState, type SessionEntry, type ToolRun } from "@pi-code/protocol";
import { describe, expect, it } from "vitest";
import { makeSnapshot } from "@/test/fixtures";
import { createConversationStore } from "./conversation-store";
import { selectSubagentSpend } from "./selectors";

const details = (...costs: number[]) => ({
  mode: costs.length > 1 ? "parallel" : "single",
  results: costs.map((cost) => ({ agent: "scout", usage: { cost } })),
});

function toolResult(
  id: string,
  parentId: string | null,
  toolName: string,
  toolCallId: string,
  resultDetails: unknown,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: "ok" }],
      details: resultDetails,
      isError: false,
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function run(patch: Partial<ToolRun> = {}): ToolRun {
  return { toolName: "subagent", args: {}, status: "running", ...patch };
}

function spend(entries: SessionEntry[], tools: Record<string, ToolRun> = {}, leafId?: string) {
  const store = createConversationStore("a1");
  store.getState().hydrate(
    makeSnapshot({
      transcript: { entries, leafId: leafId ?? entries.at(-1)?.id ?? null },
      live: { ...initialLiveState(), tools },
    }),
  );
  return selectSubagentSpend(store.getState());
}

describe("selectSubagentSpend", () => {
  it("is undefined without subagent calls; other tools are ignored", () => {
    expect(spend([])).toBeUndefined();
    expect(
      spend([toolResult("e1", null, "bash", "t1", details(1))], {
        t2: run({ toolName: "read", partialResult: { details: details(1) } }),
      }),
    ).toBeUndefined();
  });

  it("sums committed calls on all branches", () => {
    const entries = [
      toolResult("e1", null, "subagent", "t1", details(0.1, 0.2)),
      toolResult("e2", "e1", "subagent", "t2", details(0.25)),
      toolResult("e3", "e1", "subagent", "t3", details(0.05)),
      toolResult("e4", "e1", "bash", "t4", details(9)),
    ];
    expect(spend(entries, {}, "e2")).toBeCloseTo(0.6);
  });

  it("adds in-flight calls from their partial result", () => {
    const committed = [toolResult("e1", null, "subagent", "t1", details(0.5))];
    expect(spend([], { t2: run() })).toBe(0);
    expect(spend(committed, { t2: run({ partialResult: { details: details(0.1) } }) })).toBeCloseTo(
      0.6,
    );
  });

  it("adds finished calls not committed yet from their result", () => {
    expect(
      spend([], { t1: run({ status: "done", result: { details: details(0.3) } }) }),
    ).toBeCloseTo(0.3);
  });

  it("counts an aborted call as 0 but still reports it", () => {
    expect(spend([toolResult("e1", null, "subagent", "t1", {})])).toBe(0);
    expect(spend([], { t1: run({ status: "error", result: { details: {} } }) })).toBe(0);
  });
});
