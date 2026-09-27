import { describe, expect, it } from "vitest";
import { activeBranch, applyServerEventToCaches, type SessionCaches } from "./caches.ts";
import type {
  AgentInfo,
  JsonAgentSessionEvent,
  RpcSessionState,
  ServerEvent,
  SessionEntry,
  Transcript,
} from "./index.ts";

const entry = (id: string, parentId: string | null): SessionEntry =>
  ({ type: "session_info", id, parentId, timestamp: "", name: id }) as SessionEntry;

const agent: AgentInfo = {
  id: "a",
  cwd: "/p",
  status: "ready",
  isStreaming: false,
  attention: "none",
  startedAt: "",
};

const state: RpcSessionState = {
  thinkingLevel: "low",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  sessionId: "s1",
  sessionFile: "/f1",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};

const base = (): SessionCaches & { extra: { n: number } } => ({
  agent,
  state,
  transcript: { entries: [entry("a", null)], leafId: "a" },
  stats: null,
  gitStatus: null,
  extra: { n: 1 },
});

const pi = (event: unknown): ServerEvent => ({ type: "pi", event: event as JsonAgentSessionEvent });

describe("activeBranch", () => {
  const t: Transcript = {
    entries: [entry("r", null), entry("a", "r"), entry("b", "a"), entry("x", "a"), entry("y", "x")],
    leafId: "y",
  };

  it("walks parentId from the leaf to the root", () => {
    expect(activeBranch(t).map((e) => e.id)).toEqual(["r", "a", "x", "y"]);
    expect(activeBranch({ ...t, leafId: "b" }).map((e) => e.id)).toEqual(["r", "a", "b"]);
  });

  it("is empty for a null or unknown leaf, and survives cycles", () => {
    expect(activeBranch({ ...t, leafId: null })).toEqual([]);
    expect(activeBranch({ ...t, leafId: "zzz" })).toEqual([]);
    expect(
      activeBranch({ entries: [entry("p", "q"), entry("q", "p")], leafId: "p" }).map((e) => e.id),
    ).toEqual(["q", "p"]);
  });
});

describe("applyServerEventToCaches", () => {
  it("entries_appended appends new entries (deduplicated) and moves the leaf", () => {
    const c = base();
    const next = applyServerEventToCaches(c, {
      type: "entries_appended",
      entries: [entry("a", null), entry("b", "a")],
      leafId: "b",
    });
    expect(next.transcript).toEqual({ entries: [entry("a", null), entry("b", "a")], leafId: "b" });
    expect(next.extra).toBe(c.extra);
    expect(next.agent).toBe(c.agent);
    expect(
      applyServerEventToCaches(c, {
        type: "entries_appended",
        entries: [entry("a", null)],
        leafId: "a",
      }),
    ).toBe(c);
    const moved = applyServerEventToCaches(c, {
      type: "entries_appended",
      entries: [],
      leafId: null,
    });
    expect(moved.transcript.entries).toBe(c.transcript.entries);
    expect(moved.transcript.leafId).toBeNull();
  });

  it("transcript_reset replaces transcript and state and copies session fields to the agent", () => {
    const c = base();
    const newState = { ...state, sessionId: "s2", sessionFile: "/f2", sessionName: "n" };
    const transcript = { entries: [entry("z", null)], leafId: "z" };
    const next = applyServerEventToCaches(c, {
      type: "transcript_reset",
      transcript,
      state: newState,
    });
    expect(next.transcript).toBe(transcript);
    expect(next.state).toBe(newState);
    expect(next.agent).toMatchObject({ sessionId: "s2", sessionFile: "/f2", sessionName: "n" });
  });

  it("state / stats / git_status / agent_status replace their field", () => {
    const c = base();
    const s2 = { ...state, thinkingLevel: "high" as const };
    expect(applyServerEventToCaches(c, { type: "state", state: s2 }).state).toBe(s2);
    const stats = { sessionId: "s1" } as never;
    expect(applyServerEventToCaches(c, { type: "stats", stats }).stats).toBe(stats);
    const git = { branch: "main", dirty: false };
    expect(applyServerEventToCaches(c, { type: "git_status", status: git }).gitStatus).toBe(git);
    const a2 = { ...agent, attention: "input" as const };
    expect(applyServerEventToCaches(c, { type: "agent_status", agent: a2 }).agent).toBe(a2);
  });

  it("pi events patch the cached state", () => {
    const c = base();
    expect(
      applyServerEventToCaches(c, pi({ type: "thinking_level_changed", level: "minimal" })).state
        ?.thinkingLevel,
    ).toBe("minimal");
    const named = applyServerEventToCaches(c, pi({ type: "session_info_changed", name: "x" }));
    expect(named.state?.sessionName).toBe("x");
    expect(named.agent.sessionName).toBe("x");
    const running = applyServerEventToCaches(c, pi({ type: "agent_start" }));
    expect(running.state?.isStreaming).toBe(true);
    expect(running.agent.isStreaming).toBe(true);
    expect(
      applyServerEventToCaches(running, pi({ type: "agent_settled" })).state?.isStreaming,
    ).toBe(false);
    expect(
      applyServerEventToCaches(c, pi({ type: "compaction_start", reason: "manual" })).state
        ?.isCompacting,
    ).toBe(true);
    expect(
      applyServerEventToCaches(
        c,
        pi({ type: "queue_update", steering: ["a"], followUp: ["b", "c"] }),
      ).state?.pendingMessageCount,
    ).toBe(3);
  });

  it("returns the same object when nothing changes", () => {
    const c = base();
    for (const event of [
      pi({ type: "agent_settled" }),
      pi({ type: "thinking_level_changed", level: "low" }),
      pi({ type: "message_start", message: { role: "user" } }),
      { type: "resync" },
      { type: "ui_resolved", id: "x" },
      { type: "unknown_thing" } as unknown as ServerEvent,
    ] as ServerEvent[]) {
      expect(applyServerEventToCaches(c, event)).toBe(c);
    }
    const noState = { ...c, state: null };
    expect(
      applyServerEventToCaches(noState, pi({ type: "thinking_level_changed", level: "high" })),
    ).toBe(noState);
  });
});
