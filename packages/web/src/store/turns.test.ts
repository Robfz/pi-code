import { activeBranch, type SessionEntry, type Transcript } from "@pi-code/protocol";
import { describe, expect, it } from "vitest";
import { subagentCost } from "@/lib/subagent-details";
import { fixtureNames, fixtureTranscript } from "@/test/fixtures";
import { hydratedStore } from "@/test/render";
import { type Step, selectTurns, type Turn, turnStats } from "./turns";

const turnsOf = (transcript: Transcript) => selectTurns(hydratedStore({ transcript }).getState());
const fixtureTurns = (name: string) => turnsOf(fixtureTranscript(name));
const userTurns = (turns: Turn[]) => turns.filter((t) => t.user !== undefined);
const kinds = (steps: Step[]) => steps.map((s) => s.kind);

/** A transcript from entries chained in order. */
function chain(messages: unknown[]): Transcript {
  const entries = messages.map((message, i) => ({
    type: "message",
    id: `e${i}`,
    parentId: i === 0 ? null : `e${i - 1}`,
    timestamp: new Date(0).toISOString(),
    message,
  })) as SessionEntry[];
  return { entries, leafId: entries.at(-1)?.id ?? null };
}

const user = (text: string, timestamp = 0) => ({ role: "user", content: text, timestamp });
const assistant = (content: unknown[], patch: Record<string, unknown> = {}) => ({
  role: "assistant",
  content,
  stopReason: "stop",
  usage: { cost: { total: 0.01 } },
  timestamp: 0,
  ...patch,
});
const text = (t: string) => ({ type: "text", text: t });
const call = (id: string, name: string, args: unknown) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
const result = (id: string, toolName: string, patch: Record<string, unknown> = {}) => ({
  role: "toolResult",
  toolCallId: id,
  toolName,
  content: [{ type: "text", text: "ok" }],
  isError: false,
  timestamp: 0,
  ...patch,
});

describe("selectTurns", () => {
  it("plain-answer: one user turn, after a leading turn of session markers", () => {
    const turns = fixtureTurns("plain-answer");
    expect(userTurns(turns)).toHaveLength(1);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.id).toBe("start");
    expect(turns[0]?.user).toBeUndefined();
    expect(kinds(turns[0]?.steps ?? [])).toEqual(["entry", "entry"]); // model, thinking level
    expect(kinds(turns[1]?.steps ?? [])).toEqual(["thinking", "text"]);
  });

  it("a steer starts a new turn (steer-followup)", () => {
    const branch = activeBranch(fixtureTranscript("steer-followup"));
    const userIds = branch.flatMap((e) =>
      e.type === "message" && e.message.role === "user" ? [e.id] : [],
    );
    expect(userIds.length).toBeGreaterThan(2);
    const turns = userTurns(fixtureTurns("steer-followup"));
    expect(turns.map((t) => t.id)).toEqual(userIds);
    // The steered turn holds the tool call that was running when it arrived.
    expect(turns[0]?.steps.some((s) => s.kind === "tool")).toBe(true);
  });

  it("entries before the first user message form a turn without one (entry-types)", () => {
    const [first] = fixtureTurns("entry-types");
    expect(first?.id).toBe("start");
    expect(first?.user).toBeUndefined();
    expect(first?.entries.map((e) => e.type)).toEqual([
      "model_change",
      "thinking_level_change",
      "message", // the system message: in the turn, without a step
    ]);
    expect(first?.steps).toHaveLength(2);
  });

  it.each(fixtureNames())("puts every entry of %s in exactly one turn", (name) => {
    const transcript = fixtureTranscript(name);
    const branch = activeBranch(transcript);
    const seen = turnsOf(transcript).flatMap((t) => [
      ...(t.user ? [t.id] : []),
      ...t.entries.map((e) => e.id),
    ]);
    expect(seen).toEqual(branch.map((e) => e.id));
    // Steps come from the turn's own entries, in order.
    for (const turn of turnsOf(transcript)) {
      const ids = new Set(turn.entries.map((e) => e.id));
      for (const step of turn.steps) expect(ids.has(step.entryId as string)).toBe(true);
    }
  });

  it("shows stop notices as steps (abort)", () => {
    const [aborted, midTool] = userTurns(fixtureTurns("abort"));
    expect(kinds(aborted?.steps ?? []).at(-1)).toBe("stop");
    expect(kinds(midTool?.steps ?? [])).toEqual(["thinking", "tool", "stop"]);
  });

  it("is memoized on the active branch", () => {
    const store = hydratedStore({ transcript: fixtureTranscript("tool-calls") });
    expect(selectTurns(store.getState())).toBe(selectTurns(store.getState()));
  });
});

describe("turnStats", () => {
  it("final text: the text after the last tool or thinking step", () => {
    const [turn] = turnsOf(
      chain([
        user("go"),
        assistant([text("Let me look."), call("c1", "read", { path: "a" })]),
        result("c1", "read"),
        assistant([text("First part."), text("Second part.")]),
      ]),
    );
    expect(turnStats(turn as Turn).finalText).toBe("First part.\n\nSecond part.");
    const [plain] = userTurns(fixtureTurns("plain-answer"));
    expect(turnStats(plain as Turn).finalText).toBeTruthy();
  });

  it("no final text when the turn ends in a tool call", () => {
    const [turn] = turnsOf(
      chain([user("go"), assistant([text("Reading."), call("c1", "read", { path: "a" })])]),
    );
    expect(turnStats(turn as Turn).finalText).toBeUndefined();
  });

  it("duration: user message to the last assistant message's timestamp plus durationMs", () => {
    const messages = [
      user("go", 1_000),
      assistant([call("c1", "read", { path: "a" })], { timestamp: 2_000, durationMs: 300 }),
      result("c1", "read"),
      assistant([text("done")], { timestamp: 5_000, durationMs: 1_500 }),
    ];
    expect(turnStats(turnsOf(chain(messages))[0] as Turn).durationMs).toBe(5_500);
    // Legacy messages without durationMs end where the last one started.
    const legacy = messages.map((m) =>
      m.role === "assistant" ? { ...m, durationMs: undefined } : m,
    );
    expect(turnStats(turnsOf(chain(legacy))[0] as Turn).durationMs).toBe(4_000);
    // No duration without a user message.
    const [leading] = turnsOf(chain([assistant([text("hi")], { timestamp: 9 })]));
    expect(turnStats(leading as Turn).durationMs).toBeUndefined();
  });

  it("cost: assistant usage plus subagent spend (subagent)", () => {
    const [turn] = userTurns(fixtureTurns("subagent"));
    let assistants = 0;
    let spawn = 0;
    for (const entry of turn?.entries ?? []) {
      if (entry.type !== "message") continue;
      if (entry.message.role === "assistant") assistants += entry.message.usage.cost.total;
      if (entry.message.role === "toolResult") spawn += subagentCost(entry.message);
    }
    expect(spawn).toBeGreaterThan(0);
    expect(turnStats(turn as Turn).cost).toBeCloseTo(assistants + spawn, 10);
  });

  it("files: the edits of tool-calls", () => {
    const [turn] = userTurns(fixtureTurns("tool-calls"));
    expect(turnStats(turn as Turn).files).toEqual({ count: 1, additions: 1, deletions: 1 });
  });

  it("files: distinct paths of successful edits and writes", () => {
    const patch = "@@ -1,2 +1,2 @@\n-a\n+b\n c\n";
    const [turn] = turnsOf(
      chain([
        user("go"),
        assistant([
          call("w1", "write", { path: "new.txt", content: "1\n2\n3\n" }),
          call("e1", "edit", { path: "new.txt" }),
          call("e2", "edit", { file_path: "other.txt" }),
          call("e3", "edit", { path: "failed.txt" }),
          call("r1", "read", { path: "read.txt" }),
        ]),
        result("w1", "write"),
        result("e1", "edit", { details: { patch } }),
        result("e2", "edit", { details: { patch } }),
        result("e3", "edit", { isError: true }),
        result("r1", "read"),
      ]),
    );
    expect(turnStats(turn as Turn).files).toEqual({ count: 2, additions: 5, deletions: 2 });
    const [none] = userTurns(fixtureTurns("plain-answer"));
    expect(turnStats(none as Turn).files).toBeUndefined();
  });
});
