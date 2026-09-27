import { describe, expect, it } from "vitest";
import { applyServerEventToCaches, type SessionCaches } from "./caches.ts";
import type { AgentInfo, ServerEvent } from "./index.ts";
import { initialLiveState, type LiveState, reduceLive } from "./live.ts";
import { fixtureNames, fixtureToServerEvents, loadFixture } from "./testing/fixture-events.ts";

const names = fixtureNames();

function reduceAll(
  events: readonly ServerEvent[],
  from: LiveState = initialLiveState(),
): LiveState {
  return events.reduce(reduceLive, from);
}

const agent: AgentInfo = {
  id: "a1",
  cwd: "/tmp/project",
  status: "ready",
  isStreaming: false,
  attention: "none",
  startedAt: "2026-01-01T00:00:00.000Z",
};

function initialCaches(): SessionCaches {
  return {
    agent,
    state: null,
    transcript: { entries: [], leafId: null },
    stats: null,
    gitStatus: null,
  };
}

function applyAll(
  events: readonly ServerEvent[],
  from: SessionCaches = initialCaches(),
): SessionCaches {
  return events.reduce(applyServerEventToCaches, from);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function eventsOf(name: string): ServerEvent[] {
  return fixtureToServerEvents(loadFixture(name));
}

function finalFullEntries(name: string) {
  const lines = loadFixture(name);
  const fullIds = new Set(
    lines
      .filter((l) => l.dir === "in")
      .map((l) => l.line as { id?: string; type?: string; since?: string })
      .filter((c) => c.type === "get_entries" && c.since === undefined)
      .map((c) => c.id),
  );
  const last = lines
    .map((l) => l.line as { type?: string; id?: string; data?: unknown })
    .filter((r) => r.type === "response" && fullIds.has(r.id))
    .at(-1);
  return last?.data as { entries: { id: string }[]; leafId: string | null };
}

it("finds the fixtures", () => {
  expect(names.length).toBeGreaterThanOrEqual(12);
});

describe.each(names)("fixture %s", (name) => {
  const events = eventsOf(name);

  it("reduces without mutating inputs and keeps run invariants", () => {
    let state = deepFreeze(initialLiveState());
    for (const event of events) {
      deepFreeze(event);
      if (event.type === "pi" && event.event.type === "message_end") {
        const message = event.event.message;
        if (message.role === "assistant" && state.streaming) {
          // Streamed blocks agree with the authoritative message.
          for (const [index, block] of Object.entries(state.streaming.blocks)) {
            const content = message.content[Number(index)];
            if (block.type === "text")
              expect(content).toMatchObject({ type: "text", text: block.text });
            if (block.type === "thinking") {
              expect(content).toMatchObject({ type: "thinking", thinking: block.text });
            }
            if (block.type === "toolCall") {
              expect(content).toMatchObject({ type: "toolCall", id: block.id, name: block.name });
              expect(block.call).toEqual(content);
            }
          }
        }
      }
      state = deepFreeze(reduceLive(state, event));
      if (event.type === "pi" && event.event.type === "message_start") {
        const role = event.event.message.role;
        if (role === "assistant") expect(state.streaming).toEqual({ blocks: {} });
        if (role === "user") expect(state.pendingUser).toEqual(event.event.message);
      }
      if (event.type === "pi" && event.event.type === "message_end") {
        if (event.event.message.role === "assistant") expect(state.streaming).toBeUndefined();
      }
      if (event.type === "pi" && event.event.type === "agent_settled") {
        expect(state.run.active).toBe(false);
        expect(state.streaming).toBeUndefined();
        expect(state.run.retry).toBeUndefined();
        expect(state.run.compaction).toBeUndefined();
      }
      if (event.type === "pi" && event.event.type === "agent_start") {
        expect(state.run.active).toBe(true);
      }
      // System messages never show up live (tool details may embed a child agent's transcript).
      expect(JSON.stringify([state.streaming, state.pendingUser])).not.toContain('"role":"system"');
    }

    // Everything was committed or resolved by the end of the recording.
    expect(state.run.active).toBe(false);
    expect(state.streaming).toBeUndefined();
    expect(state.pendingUser).toBeUndefined();
    expect(state.tools).toEqual({});
    expect(state.curator).toEqual({});
    expect(state.bash).toEqual({});
    expect(state.dialogs).toEqual([]);
    expect(state.queue).toEqual({ steering: [], followUp: [] });
    expect(state.statuses.mcp).toContain("MCP");
  });

  it("snapshot at any event index + the rest equals the full reduction", () => {
    const prefixes: LiveState[] = [initialLiveState()];
    for (const event of events) prefixes.push(reduceLive(prefixes.at(-1) as LiveState, event));
    const final = prefixes.at(-1) as LiveState;
    expect(roundTrip(final)).toEqual(final);
    for (let k = 0; k <= events.length; k++) {
      const resumed = reduceAll(events.slice(k), roundTrip(prefixes[k] as LiveState));
      expect(resumed, `resume at ${k}`).toEqual(final);
    }
  });

  it("keeps the committed caches in sync with pi's entries", () => {
    const prefixes: SessionCaches[] = [initialCaches()];
    for (const event of events)
      prefixes.push(applyServerEventToCaches(prefixes.at(-1) as SessionCaches, event));
    const final = prefixes.at(-1) as SessionCaches;
    const expected = finalFullEntries(name);
    expect(final.transcript.entries.map((e) => e.id)).toEqual(expected.entries.map((e) => e.id));
    expect(final.transcript.leafId).toBe(expected.leafId);
    expect(final.state).not.toBeNull();
    expect(final.stats).not.toBeNull();
    expect(final.state?.isStreaming).toBe(false);
    for (let k = 0; k <= events.length; k += 7) {
      expect(applyAll(events.slice(k), roundTrip(prefixes[k] as SessionCaches))).toEqual(final);
    }
  });
});

describe("fixture scenarios", () => {
  it("plain-answer: streams text and thinking, then leaves only the extension status", () => {
    const events = eventsOf("plain-answer");
    let state = initialLiveState();
    let sawText = false;
    for (const event of events) {
      state = reduceLive(state, event);
      const blocks = state.streaming?.blocks;
      if (blocks?.[1]?.type === "text" && blocks[1].text.length > 0) sawText = true;
    }
    expect(sawText).toBe(true);
    expect(state).toEqual({
      ...initialLiveState(),
      statuses: { mcp: "\u001b[38;2;138;190;183m🔌 MCP: 2 servers enabled\u001b[39m" },
    });
  });

  it("plain-answer: the thinking block is done before the text starts", () => {
    const events = eventsOf("plain-answer");
    let state = initialLiveState();
    for (const event of events) {
      state = reduceLive(state, event);
      if (event.type === "pi" && event.event.type === "message_update") {
        const e = event.event.assistantMessageEvent;
        if (e.type === "text_start") {
          expect(state.streaming?.blocks[0]).toMatchObject({ type: "thinking", done: true });
          expect(state.streaming?.blocks[1]).toEqual({ type: "text", text: "", done: false });
        }
      }
    }
  });

  it("extension-dialog: fire-and-forget UI, dialogs in order, and a timed-out dialog", () => {
    const events = eventsOf("extension-dialog");
    let state = initialLiveState();
    const dialogCounts: number[] = [];
    for (const event of events) {
      state = reduceLive(state, event);
      if (
        event.type === "ui_request" &&
        event.request.method === "select" &&
        state.dialogs.length === 1
      ) {
        if (event.request.title === "S0 pick a fruit") {
          expect(state.statuses.s0).toBe("s0 status text");
          expect(state.widgets).toEqual({
            s0: { lines: ["s0 widget line 1", "s0 widget line 2"], placement: "aboveEditor" },
            "s0-below": { lines: ["s0 below"], placement: "belowEditor" },
          });
          expect(state.title).toBe("s0 title");
          expect(state.editorText).toEqual({ text: "s0 editor text", nonce: 1 });
        } else {
          expect(state.dialogs[0]?.expiresAt).toBe((state.dialogs[0]?.receivedAt ?? 0) + 1500);
        }
      }
      dialogCounts.push(state.dialogs.length);
    }
    expect(Math.max(...dialogCounts)).toBe(1);
    expect(events.filter((e) => e.type === "ui_resolved")).toHaveLength(5);
    expect(state.statuses).toEqual({ mcp: expect.stringContaining("MCP") });
    expect(state.widgets).toEqual({});
    expect(state.notices.map((n) => n.kind)).toEqual(["info", "warning", "info"]);
    expect(state.notices[2]?.message).toContain("s0 result");
  });

  it("steer-followup: queue, pending user messages and bash partial results", () => {
    const events = eventsOf("steer-followup");
    let state = initialLiveState();
    let maxQueue = 0;
    let sawEmptyPartial = false;
    for (const event of events) {
      state = reduceLive(state, event);
      maxQueue = Math.max(maxQueue, state.queue.steering.length + state.queue.followUp.length);
      if (event.type === "pi" && event.event.type === "tool_execution_update") {
        const run = state.tools[event.event.toolCallId];
        expect(run?.status).toBe("running");
        if (JSON.stringify(run?.partialResult) === '{"content":[]}') sawEmptyPartial = true;
      }
      if (event.type === "entries_appended") expect(state.pendingUser).toBeUndefined();
    }
    expect(maxQueue).toBe(3);
    expect(sawEmptyPartial).toBe(true);
  });

  it("abort: an abort mid-tool is not reported as an error", () => {
    const events = eventsOf("abort");
    let state = initialLiveState();
    let sawToolError = false;
    for (const event of events) {
      state = reduceLive(state, event);
      if (event.type === "pi" && event.event.type === "tool_execution_end") {
        expect(state.tools[event.event.toolCallId]?.status).toBe("error");
        sawToolError = true;
      }
      expect(state.run.lastError).toBeUndefined();
    }
    expect(sawToolError).toBe(true);
  });

  it("subagent: a dialog arrives while the tool runs", () => {
    const events = eventsOf("subagent");
    let state = initialLiveState();
    let overlapped = false;
    for (const event of events) {
      state = reduceLive(state, event);
      if (
        state.dialogs.length > 0 &&
        Object.values(state.tools).some((t) => t.status === "running")
      ) {
        overlapped = true;
      }
    }
    expect(overlapped).toBe(true);
  });

  it("bash-command: streamed output accumulates and is dropped once committed", () => {
    const events = eventsOf("bash-command");
    let state = initialLiveState();
    let doneSeen = 0;
    for (const event of events) {
      state = reduceLive(state, event);
      if (event.type === "bash_done") {
        const run = state.bash[event.id];
        expect(run?.done).toEqual(event.result);
        expect(run?.command).toBeTruthy();
        expect(run?.output).toBe(event.result.output);
        doneSeen++;
      }
    }
    expect(doneSeen).toBe(3);
    expect(state.bash).toEqual({});
  });

  it("compaction: failed compaction reports an error, then clears on the next run", () => {
    const events = eventsOf("compaction");
    let state = initialLiveState();
    const errors: (string | undefined)[] = [];
    for (const event of events) {
      state = reduceLive(state, event);
      if (event.type === "pi" && event.event.type === "compaction_start") {
        expect(state.run.compaction).toEqual({ reason: "manual" });
      }
      if (event.type === "pi" && event.event.type === "compaction_end") {
        expect(state.run.compaction).toBeUndefined();
        errors.push(state.run.lastError);
      }
    }
    expect(errors[0]).toContain("Nothing to compact");
    expect(state.run.lastError).toBeUndefined();
  });

  it("entry-types: session switches reset the transcript", () => {
    const events = eventsOf("entry-types");
    expect(events.filter((e) => e.type === "transcript_reset").length).toBeGreaterThanOrEqual(2);
    const caches = applyAll(events);
    expect(caches.transcript.entries.map((e) => e.type)).toEqual([
      "model_change",
      "thinking_level_change",
    ]);
  });
});
