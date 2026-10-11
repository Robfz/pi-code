import { describe, expect, it } from "vitest";
import type {
  AgentInfo,
  AssistantMessage,
  BashResult,
  JsonAgentSessionEvent,
  RpcExtensionUIRequest,
  RpcSessionState,
  ServerEvent,
  SessionEntry,
  ToolCall,
  UserMessage,
} from "./index.ts";
import {
  effectiveStopReason,
  initialLiveState,
  isDialogRequest,
  type LiveState,
  MAX_NOTICES,
  reduceLive,
} from "./live.ts";

// ---------------------------------------------------------------------------
// Builders

const pi = (event: unknown, receivedAt?: number): ServerEvent =>
  receivedAt === undefined
    ? { type: "pi", event: event as JsonAgentSessionEvent }
    : { type: "pi", event: event as JsonAgentSessionEvent, receivedAt };

const update = (assistantMessageEvent: unknown, receivedAt?: number): ServerEvent =>
  pi({ type: "message_update", usage: {}, assistantMessageEvent }, receivedAt);

const ui = (request: Record<string, unknown>, receivedAt = 1000): ServerEvent => ({
  type: "ui_request",
  request: {
    type: "extension_ui_request",
    id: `ui-${Math.random()}`,
    ...request,
  } as RpcExtensionUIRequest,
  receivedAt,
});

const user: UserMessage = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "m",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  } as AssistantMessage;
}

const toolCall: ToolCall = {
  type: "toolCall",
  id: "t1",
  name: "read",
  arguments: { path: "a.txt" },
};

function messageEntry(id: string, message: unknown): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: "", message } as SessionEntry;
}

const bashResult: BashResult = { output: "one\n", exitCode: 0, cancelled: false, truncated: false };

const state0 = { sessionId: "s" } as RpcSessionState;

function reduceAll(events: ServerEvent[], from: LiveState = initialLiveState()): LiveState {
  return events.reduce(reduceLive, from);
}

// ---------------------------------------------------------------------------

describe("initialLiveState", () => {
  it("is idle and empty, and a fresh object each time", () => {
    const a = initialLiveState();
    expect(a).toEqual({
      run: { active: false },
      tools: {},
      curator: {},
      queue: { steering: [], followUp: [] },
      dialogs: [],
      statuses: {},
      widgets: {},
      notices: [],
      bash: {},
      thinkingMs: {},
    });
    expect(initialLiveState()).not.toBe(a);
  });
});

describe("ignored events", () => {
  const s = reduceAll([
    pi({ type: "agent_start" }),
    ui({ method: "setStatus", statusKey: "k", statusText: "v" }),
  ]);

  it.each<[string, ServerEvent]>([
    ["unknown server event", { type: "something_new" } as unknown as ServerEvent],
    ["unknown pi event", pi({ type: "brand_new_event" })],
    ["unknown assistant event", update({ type: "brand_new", contentIndex: 0 })],
    ["unknown ui method", ui({ method: "newMethod" })],
    ["turn_start", pi({ type: "turn_start" })],
    ["turn_end", pi({ type: "turn_end", message: assistant(), toolResults: [] })],
    ["agent_end", pi({ type: "agent_end", messages: [], willRetry: false })],
    ["entry_appended", pi({ type: "entry_appended", entry: messageEntry("e", user) })],
    ["thinking_level_changed", pi({ type: "thinking_level_changed", level: "high" })],
    ["session_info_changed", pi({ type: "session_info_changed", name: "x" })],
    ["pi bash_execution_update", pi({ type: "bash_execution_update", id: "b", delta: "x" })],
    ["summarization_retry_finished", pi({ type: "summarization_retry_finished" })],
    [
      "system message_start",
      pi({ type: "message_start", message: { role: "system", content: "", timestamp: 1 } }),
    ],
    [
      "system message_end",
      pi({ type: "message_end", message: { role: "system", content: "", timestamp: 1 } }),
    ],
    [
      "toolResult message_start",
      pi({ type: "message_start", message: { role: "toolResult", toolCallId: "t" } }),
    ],
    [
      "custom message_end",
      pi({ type: "message_end", message: { role: "custom", customType: "c" } }),
    ],
    ["state", { type: "state", state: state0 }],
    ["stats", { type: "stats", stats: {} as never }],
    ["git_status", { type: "git_status", status: { branch: "main", dirty: true } }],
    ["agent_status ready", { type: "agent_status", agent: { status: "ready" } as AgentInfo }],
    ["ui_resolved for unknown id", { type: "ui_resolved", id: "nope" }],
    [
      "entries_appended without anything to clear",
      { type: "entries_appended", entries: [], leafId: "x" },
    ],
    [
      "transcript_reset with nothing finished",
      { type: "transcript_reset", transcript: { entries: [], leafId: null }, state: state0 },
    ],
    ["setStatus with the same text", ui({ method: "setStatus", statusKey: "k", statusText: "v" })],
    ["clearing an unknown status", ui({ method: "setStatus", statusKey: "zz" })],
    ["clearing an unknown widget", ui({ method: "setWidget", widgetKey: "zz" })],
  ])("%s returns the same state", (_, event) => {
    expect(reduceLive(s, event)).toBe(s);
  });
});

describe("run lifecycle", () => {
  it("agent_start activates and clears the last error", () => {
    const s = reduceAll([
      pi({
        type: "message_end",
        message: assistant({ stopReason: "error", errorMessage: "boom" }),
      }),
      pi({ type: "agent_start" }),
    ]);
    expect(s.run).toEqual({ active: true });
  });

  it("agent_settled deactivates, clears retry, compaction and streaming, keeps lastError", () => {
    const s = reduceAll([
      pi({ type: "agent_start" }),
      pi({ type: "compaction_start", reason: "overflow" }),
      pi({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: "529",
      }),
      pi({ type: "message_start", message: assistant() }),
      pi({
        type: "message_end",
        message: assistant({ stopReason: "error", errorMessage: "overloaded" }),
      }),
      pi({ type: "message_start", message: assistant() }),
      pi({ type: "agent_settled" }),
    ]);
    expect(s.run).toEqual({ active: false, lastError: "overloaded" });
    expect(s.streaming).toBeUndefined();
  });

  it("agent_settled when already idle returns the same state", () => {
    const s = initialLiveState();
    expect(reduceLive(s, pi({ type: "agent_settled" }))).toBe(s);
  });

  it("agent_status exited settles the run but keeps dialogs", () => {
    const s = reduceAll([
      pi({ type: "agent_start" }),
      pi({ type: "message_start", message: assistant() }),
      ui({ method: "confirm", title: "t", message: "m" }),
      { type: "agent_status", agent: { status: "exited" } as AgentInfo },
    ]);
    expect(s.run.active).toBe(false);
    expect(s.streaming).toBeUndefined();
    expect(s.dialogs).toHaveLength(1);
  });

  it("compaction_start / compaction_end", () => {
    const started = reduceLive(
      initialLiveState(),
      pi({ type: "compaction_start", reason: "threshold" }),
    );
    expect(started.run.compaction).toEqual({ reason: "threshold" });
    const ok = reduceLive(
      started,
      pi({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false }),
    );
    expect(ok.run).toEqual({ active: false });
    const failed = reduceLive(
      started,
      pi({
        type: "compaction_end",
        reason: "threshold",
        aborted: false,
        willRetry: false,
        errorMessage: "nope",
      }),
    );
    expect(failed.run).toEqual({ active: false, lastError: "nope" });
    const aborted = reduceLive(
      started,
      pi({
        type: "compaction_end",
        reason: "threshold",
        aborted: true,
        willRetry: false,
        errorMessage: "cancelled",
      }),
    );
    expect(aborted.run.lastError).toBeUndefined();
  });

  it("a manual compaction_start clears the previous lastError; automatic ones keep it", () => {
    const failed: LiveState = { ...initialLiveState(), run: { active: false, lastError: "old" } };
    const manual = reduceLive(failed, pi({ type: "compaction_start", reason: "manual" }));
    expect(manual.run).toEqual({ active: false, compaction: { reason: "manual" } });
    const auto = reduceLive(failed, pi({ type: "compaction_start", reason: "threshold" }));
    expect(auto.run.lastError).toBe("old");
  });

  it("auto_retry_start / auto_retry_end", () => {
    const retrying = reduceLive(
      initialLiveState(),
      pi(
        {
          type: "auto_retry_start",
          attempt: 2,
          maxAttempts: 3,
          delayMs: 4000,
          errorMessage: "529",
        },
        5000,
      ),
    );
    expect(retrying.run.retry).toEqual({
      attempt: 2,
      maxAttempts: 3,
      delayMs: 4000,
      errorMessage: "529",
      startedAt: 5000,
    });
    const unstamped = reduceLive(
      initialLiveState(),
      pi({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "x" }),
    );
    expect(unstamped.run.retry?.startedAt).toBe(0);

    const withError = { ...retrying, run: { ...retrying.run, lastError: "529" } };
    expect(
      reduceLive(withError, pi({ type: "auto_retry_end", success: true, attempt: 2 })).run,
    ).toEqual({ active: false });
    expect(
      reduceLive(
        retrying,
        pi({ type: "auto_retry_end", success: false, attempt: 3, finalError: "gave up" }),
      ).run,
    ).toEqual({ active: false, lastError: "gave up" });
  });
});

describe("streaming assistant message", () => {
  const start = pi({ type: "message_start", message: assistant() });

  it("message_start opens an empty streaming message", () => {
    expect(reduceLive(initialLiveState(), start).streaming).toEqual({ timestamp: 1, blocks: {} });
  });

  it("text and thinking: start, deltas, end", () => {
    const s = reduceAll([
      start,
      update({ type: "thinking_start", contentIndex: 0 }),
      update({ type: "thinking_delta", contentIndex: 0, delta: "hm" }),
      update({ type: "thinking_delta", contentIndex: 0, delta: "m" }),
      update({ type: "thinking_end", contentIndex: 0, content: "hmm." }),
      update({ type: "text_start", contentIndex: 1 }),
      update({ type: "text_delta", contentIndex: 1, delta: "Hel" }),
      update({ type: "text_delta", contentIndex: 1, delta: "lo" }),
    ]);
    expect(s.streaming?.blocks).toEqual({
      0: { type: "thinking", text: "hmm.", done: true },
      1: { type: "text", text: "Hello", done: false },
    });
    const ended = reduceLive(s, update({ type: "text_end", contentIndex: 1, content: "Hello!" }));
    expect(ended.streaming?.blocks[1]).toEqual({ type: "text", text: "Hello!", done: true });
    expect(ended.streaming?.blocks[0]).toBe(s.streaming?.blocks[0]);
  });

  it("a delta without a start creates the block", () => {
    const s = reduceAll([update({ type: "text_delta", contentIndex: 2, delta: "x" })]);
    expect(s.streaming?.blocks[2]).toEqual({ type: "text", text: "x", done: false });
  });

  it("an empty delta on an existing block returns the same state", () => {
    const s = reduceAll([start, update({ type: "text_start", contentIndex: 0 })]);
    expect(reduceLive(s, update({ type: "text_delta", contentIndex: 0, delta: "" }))).toBe(s);
  });

  it("tool calls: start, deltas, end", () => {
    const s = reduceAll([
      start,
      update({ type: "toolcall_start", contentIndex: 0, id: "t1", toolName: "read" }),
      update({ type: "toolcall_delta", contentIndex: 0, delta: "" }),
      update({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":' }),
      update({ type: "toolcall_delta", contentIndex: 0, delta: '"a.txt"}' }),
    ]);
    expect(s.streaming?.blocks[0]).toEqual({
      type: "toolCall",
      id: "t1",
      name: "read",
      argsText: '{"path":"a.txt"}',
    });
    const ended = reduceLive(s, update({ type: "toolcall_end", contentIndex: 0, toolCall }));
    expect(ended.streaming?.blocks[0]).toEqual({
      type: "toolCall",
      id: "t1",
      name: "read",
      argsText: '{"path":"a.txt"}',
      call: toolCall,
    });
  });

  it("toolcall_end without deltas derives argsText from the call", () => {
    const s = reduceAll([start, update({ type: "toolcall_end", contentIndex: 0, toolCall })]);
    expect(s.streaming?.blocks[0]).toMatchObject({ argsText: '{"path":"a.txt"}', call: toolCall });
  });

  it("start / done / error assistant events are ignored", () => {
    const s = reduceAll([start]);
    expect(reduceLive(s, update({ type: "start" }))).toBe(s);
    expect(reduceLive(s, update({ type: "done", reason: "stop" }))).toBe(s);
    expect(reduceLive(s, update({ type: "error", reason: "aborted" }))).toBe(s);
  });

  it("message_end(assistant) clears streaming", () => {
    const s = reduceAll([start, update({ type: "text_delta", contentIndex: 0, delta: "x" })]);
    const ended = reduceLive(s, pi({ type: "message_end", message: assistant() }));
    expect(ended.streaming).toBeUndefined();
    expect("streaming" in ended).toBe(false);
    expect(ended.run).toBe(s.run);
  });

  it("message_end with stopReason error sets lastError", () => {
    const s = reduceAll([
      start,
      pi({ type: "message_end", message: assistant({ stopReason: "error", errorMessage: "529" }) }),
    ]);
    expect(s.run.lastError).toBe("529");
  });

  it("an abort mid-tool (empty error turn) does not set lastError", () => {
    const aborted = assistant({ stopReason: "error", errorMessage: "This operation was aborted" });
    const s = reduceAll([start, pi({ type: "message_end", message: aborted })]);
    expect(s.run.lastError).toBeUndefined();
    expect(effectiveStopReason(aborted)).toBe("aborted");
    expect(effectiveStopReason(assistant({ stopReason: "error", errorMessage: "529" }))).toBe(
      "error",
    );
    expect(effectiveStopReason(assistant({ stopReason: "aborted" }))).toBe("aborted");
  });

  it("slice identity: deltas don't replace unrelated slices", () => {
    const s = reduceAll([start, update({ type: "text_start", contentIndex: 0 })]);
    const next = reduceLive(s, update({ type: "text_delta", contentIndex: 0, delta: "a" }));
    expect(next).not.toBe(s);
    for (const key of [
      "run",
      "tools",
      "curator",
      "queue",
      "dialogs",
      "statuses",
      "widgets",
      "notices",
      "bash",
      "thinkingMs",
    ] as const) {
      expect(next[key]).toBe(s[key]);
    }
  });
});

describe("user messages", () => {
  it("message_start(user) sets pendingUser; entries_appended clears it", () => {
    const s = reduceAll([
      pi({ type: "message_start", message: user }),
      pi({ type: "message_end", message: user }),
    ]);
    expect(s.pendingUser).toEqual(user);
    const committed = reduceLive(s, {
      type: "entries_appended",
      entries: [messageEntry("u", user)],
      leafId: "u",
    });
    expect(committed.pendingUser).toBeUndefined();
  });

  it("message_end(user) after the commit does not bring the message back", () => {
    const s = reduceAll([
      pi({ type: "message_start", message: user }),
      { type: "entries_appended", entries: [messageEntry("u", user)], leafId: "u" },
    ]);
    expect(reduceLive(s, pi({ type: "message_end", message: user }))).toBe(s);
  });
});

describe("tools", () => {
  const started = reduceAll([
    pi({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "ls" },
    }),
  ]);

  it("tool_execution_start", () => {
    expect(started.tools).toEqual({
      t1: { toolName: "bash", args: { command: "ls" }, status: "running" },
    });
  });

  it("tool_execution_update replaces partialResult", () => {
    const s = reduceAll(
      [
        pi({
          type: "tool_execution_update",
          toolCallId: "t1",
          toolName: "bash",
          args: { command: "ls" },
          partialResult: { content: [] },
        }),
        pi({
          type: "tool_execution_update",
          toolCallId: "t1",
          toolName: "bash",
          args: { command: "ls" },
          partialResult: { content: [{ type: "text", text: "a\n" }], details: {} },
        }),
      ],
      started,
    );
    expect(s.tools.t1).toEqual({
      toolName: "bash",
      args: { command: "ls" },
      status: "running",
      partialResult: { content: [{ type: "text", text: "a\n" }], details: {} },
    });
  });

  it("tool_execution_end stores the result and drops the partial result", () => {
    const s = reduceAll(
      [
        pi({
          type: "tool_execution_update",
          toolCallId: "t1",
          toolName: "bash",
          args: {},
          partialResult: { content: [] },
        }),
        pi({
          type: "tool_execution_end",
          toolCallId: "t1",
          toolName: "bash",
          result: { content: [] },
          isError: false,
        }),
      ],
      started,
    );
    expect(s.tools.t1).toEqual({
      toolName: "bash",
      args: { command: "ls" },
      status: "done",
      result: { content: [] },
    });
    const failed = reduceLive(
      started,
      pi({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "bash",
        result: { content: [] },
        isError: true,
      }),
    );
    expect(failed.tools.t1?.status).toBe("error");
  });

  it("entries_appended removes tools (and their curator URL) whose results are committed", () => {
    const s = reduceAll(
      [
        pi({ type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: {} }),
        { type: "curator", toolCallId: "t1", url: "https://h:8443/?session=x" },
        pi({
          type: "tool_execution_end",
          toolCallId: "t1",
          toolName: "bash",
          result: { content: [] },
          isError: false,
        }),
        {
          type: "entries_appended",
          entries: [
            messageEntry("r1", {
              role: "toolResult",
              toolCallId: "t1",
              toolName: "bash",
              content: [],
              isError: false,
            }),
          ],
          leafId: "r1",
        },
      ],
      started,
    );
    expect(Object.keys(s.tools)).toEqual(["t2"]);
    expect(s.curator).toEqual({});
  });
});

describe("timing", () => {
  const start = pi({ type: "message_start", message: assistant({ timestamp: 7000 }) }, 1000);
  const toolStart = pi(
    { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} },
    2000,
  );
  const toolUpdate = pi(
    {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
      partialResult: { content: [] },
    },
    2500,
  );
  const toolEnd = (receivedAt?: number, durationMs?: number) =>
    pi(
      {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "bash",
        result: { content: [] },
        isError: false,
        ...(durationMs === undefined ? {} : { durationMs }),
      },
      receivedAt,
    );

  it("thinking and text blocks get startedAt at their start, kept through deltas, and endedAt", () => {
    const s = reduceAll([
      start,
      update({ type: "thinking_start", contentIndex: 0 }, 1100),
      update({ type: "thinking_delta", contentIndex: 0, delta: "hm" }, 1200),
      update({ type: "thinking_end", contentIndex: 0, content: "hm" }, 13_100),
      update({ type: "text_start", contentIndex: 1 }, 13_200),
      update({ type: "text_delta", contentIndex: 1, delta: "Hi" }, 13_300),
    ]);
    expect(s.streaming?.blocks).toEqual({
      0: { type: "thinking", text: "hm", done: true, startedAt: 1100, endedAt: 13_100 },
      1: { type: "text", text: "Hi", done: false, startedAt: 13_200 },
    });
    const ended = reduceLive(
      s,
      update({ type: "text_end", contentIndex: 1, content: "Hi" }, 14_000),
    );
    expect(ended.streaming?.blocks[1]).toEqual({
      type: "text",
      text: "Hi",
      done: true,
      startedAt: 13_200,
      endedAt: 14_000,
    });
  });

  it("a block created by a delta gets startedAt from it", () => {
    const s = reduceAll([
      start,
      update({ type: "thinking_delta", contentIndex: 0, delta: "a" }, 1500),
      update({ type: "thinking_delta", contentIndex: 0, delta: "b" }, 1600),
      update({ type: "toolcall_delta", contentIndex: 1, delta: "{" }, 1700),
    ]);
    expect(s.streaming?.blocks[0]).toEqual({
      type: "thinking",
      text: "ab",
      done: false,
      startedAt: 1500,
    });
    expect(s.streaming?.blocks[1]).toMatchObject({ type: "toolCall", startedAt: 1700 });
  });

  it("tool call blocks get startedAt at toolcall_start and endedAt at toolcall_end", () => {
    const s = reduceAll([
      start,
      update({ type: "toolcall_start", contentIndex: 0, id: "t1", toolName: "read" }, 1100),
      update({ type: "toolcall_delta", contentIndex: 0, delta: "{}" }, 1200),
      update({ type: "toolcall_end", contentIndex: 0, toolCall }, 1300),
    ]);
    expect(s.streaming?.blocks[0]).toMatchObject({ startedAt: 1100, endedAt: 1300 });
  });

  it("events without receivedAt leave the timing fields absent", () => {
    const s = reduceAll([
      pi({ type: "agent_start" }),
      pi({ type: "message_start", message: assistant({ timestamp: 7000 }) }),
      update({ type: "thinking_start", contentIndex: 0 }),
      update({ type: "thinking_end", contentIndex: 0, content: "hm" }),
      update({ type: "text_delta", contentIndex: 1, delta: "x" }),
      update({ type: "toolcall_start", contentIndex: 2, id: "t1", toolName: "bash" }),
      update({ type: "toolcall_end", contentIndex: 2, toolCall }),
      pi({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} }),
      toolEnd(),
    ]);
    expect(s.run).not.toHaveProperty("startedAt");
    for (const block of Object.values(s.streaming?.blocks ?? {})) {
      expect(block).not.toHaveProperty("startedAt");
      expect(block).not.toHaveProperty("endedAt");
    }
    expect(s.tools.t1).not.toHaveProperty("startedAt");
    expect(s.tools.t1).not.toHaveProperty("durationMs");
    expect(s.thinkingMs).toEqual({});
  });

  it("a tool keeps its startedAt through updates and the end", () => {
    const running = reduceAll([toolStart, toolUpdate]);
    expect(running.tools.t1).toMatchObject({ status: "running", startedAt: 2000 });
    expect(running.tools.t1).not.toHaveProperty("durationMs");
    const done = reduceLive(running, toolEnd(5000, 2900));
    expect(done.tools.t1).toMatchObject({ status: "done", startedAt: 2000 });
  });

  it("durationMs comes from the event, else from receivedAt", () => {
    const running = reduceAll([toolStart, toolUpdate]);
    expect(reduceLive(running, toolEnd(5000, 2900)).tools.t1?.durationMs).toBe(2900);
    expect(reduceLive(running, toolEnd(5000)).tools.t1?.durationMs).toBe(3000);
    expect(reduceLive(running, toolEnd(undefined, 2900)).tools.t1?.durationMs).toBe(2900);
    expect(reduceLive(running, toolEnd())).not.toHaveProperty("tools.t1.durationMs");
  });

  it("agent_start sets run.startedAt and agent_settled drops it", () => {
    const running = reduceAll([pi({ type: "agent_start" }, 900)]);
    expect(running.run).toEqual({ active: true, startedAt: 900 });
    expect(reduceLive(running, pi({ type: "agent_settled" }, 9000)).run).toEqual({
      active: false,
    });
    expect(reduceLive(running, pi({ type: "agent_start" })).run).toEqual({ active: true });
  });

  it("thinking_end writes thinkingMs under the message timestamp and content index", () => {
    const s = reduceAll([
      pi({ type: "agent_start" }, 900),
      start,
      update({ type: "text_start", contentIndex: 0 }, 1050),
      update({ type: "text_end", contentIndex: 0, content: "" }, 1080),
      update({ type: "thinking_start", contentIndex: 1 }, 1100),
      update({ type: "thinking_end", contentIndex: 1, content: "hm" }, 13_100),
    ]);
    expect(s.thinkingMs).toEqual({ "7000:1": 12_000 });

    const next = reduceAll(
      [
        pi({ type: "message_end", message: assistant({ timestamp: 7000 }) }, 13_500),
        pi({ type: "message_start", message: assistant({ timestamp: 8000 }) }, 14_000),
        update({ type: "thinking_start", contentIndex: 0 }, 14_000),
        update({ type: "thinking_end", contentIndex: 0, content: "ok" }, 15_500),
        pi({ type: "agent_settled" }, 16_000),
      ],
      s,
    );
    expect(next.streaming).toBeUndefined();
    expect(next.thinkingMs).toEqual({ "7000:1": 12_000, "8000:0": 1500 });
  });
});

describe("curator", () => {
  it("records the proxied URL per tool call", () => {
    const s = reduceLive(initialLiveState(), { type: "curator", toolCallId: "t1", url: "u" });
    expect(s.curator).toEqual({ t1: "u" });
    expect(reduceLive(s, { type: "curator", toolCallId: "t1", url: "u" })).toBe(s);
  });
});

describe("queue_update", () => {
  it("replaces the queue", () => {
    const s = reduceLive(
      initialLiveState(),
      pi({ type: "queue_update", steering: ["a"], followUp: ["b", "c"] }),
    );
    expect(s.queue).toEqual({ steering: ["a"], followUp: ["b", "c"] });
  });
});

describe("extension UI", () => {
  it("dialogs append in order with expiresAt from timeout; duplicates are ignored", () => {
    const select: ServerEvent = {
      type: "ui_request",
      request: {
        type: "extension_ui_request",
        id: "d1",
        method: "select",
        title: "t",
        options: ["a"],
        timeout: 1500,
      },
      receivedAt: 1000,
    };
    const s = reduceAll([
      select,
      select,
      {
        type: "ui_request",
        request: { type: "extension_ui_request", id: "d2", method: "editor", title: "e" },
        receivedAt: 2000,
      },
    ]);
    expect(s.dialogs).toEqual([
      { request: (select as { request: unknown }).request, receivedAt: 1000, expiresAt: 2500 },
      {
        request: { type: "extension_ui_request", id: "d2", method: "editor", title: "e" },
        receivedAt: 2000,
      },
    ]);
    expect(
      reduceLive(s, { type: "ui_resolved", id: "d1" }).dialogs.map((d) => d.request.id),
    ).toEqual(["d2"]);
  });

  it("dialogs are removed only by ui_resolved", () => {
    const s = reduceAll([
      ui({ method: "input", title: "i", timeout: 10 }, 0),
      pi({ type: "agent_settled" }),
      { type: "transcript_reset", transcript: { entries: [], leafId: null }, state: state0 },
      { type: "entries_appended", entries: [messageEntry("u", user)], leafId: "u" },
    ]);
    expect(s.dialogs).toHaveLength(1);
  });

  it("notify appends notices, capped at MAX_NOTICES", () => {
    const events = Array.from({ length: MAX_NOTICES + 5 }, (_, i) =>
      ui({ method: "notify", message: `n${i}`, notifyType: i === 0 ? "error" : undefined }, i),
    );
    const s = reduceAll(events);
    expect(s.notices).toHaveLength(MAX_NOTICES);
    expect(s.notices[0]).toMatchObject({ message: "n5", kind: "info", at: 5 });
    expect(s.notices.at(-1)?.message).toBe(`n${MAX_NOTICES + 4}`);
    expect(reduceAll(events.slice(0, 1)).notices[0]?.kind).toBe("error");
  });

  it("setStatus sets and clears", () => {
    const s = reduceAll([
      ui({ method: "setStatus", statusKey: "a", statusText: "x" }),
      ui({ method: "setStatus", statusKey: "b", statusText: "y" }),
    ]);
    expect(s.statuses).toEqual({ a: "x", b: "y" });
    expect(reduceLive(s, ui({ method: "setStatus", statusKey: "a" })).statuses).toEqual({ b: "y" });
  });

  it("setWidget sets (default placement aboveEditor) and clears", () => {
    const s = reduceAll([
      ui({ method: "setWidget", widgetKey: "w", widgetLines: ["1"] }),
      ui({
        method: "setWidget",
        widgetKey: "v",
        widgetLines: ["2"],
        widgetPlacement: "belowEditor",
      }),
    ]);
    expect(s.widgets).toEqual({
      w: { lines: ["1"], placement: "aboveEditor" },
      v: { lines: ["2"], placement: "belowEditor" },
    });
    expect(reduceLive(s, ui({ method: "setWidget", widgetKey: "w" })).widgets).toEqual({
      v: { lines: ["2"], placement: "belowEditor" },
    });
  });

  it("setTitle", () => {
    expect(reduceLive(initialLiveState(), ui({ method: "setTitle", title: "T" })).title).toBe("T");
  });

  it("set_editor_text bumps the nonce every time", () => {
    const s = reduceAll([
      ui({ method: "set_editor_text", text: "a" }),
      ui({ method: "set_editor_text", text: "a" }),
    ]);
    expect(s.editorText).toEqual({ text: "a", nonce: 2 });
  });

  it("isDialogRequest", () => {
    const req = (method: string) =>
      ({ type: "extension_ui_request", id: "x", method }) as RpcExtensionUIRequest;
    expect(["select", "confirm", "input", "editor"].every((m) => isDialogRequest(req(m)))).toBe(
      true,
    );
    expect(
      ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].some((m) =>
        isDialogRequest(req(m)),
      ),
    ).toBe(false);
  });
});

describe("bash", () => {
  it("bash_output accumulates; bash_done records the result", () => {
    const s = reduceAll([
      { type: "bash_output", id: "b1", delta: "one\n", command: "echo one" },
      { type: "bash_output", id: "b1", delta: "two\n" },
      { type: "bash_done", id: "b1", result: bashResult },
    ]);
    expect(s.bash).toEqual({ b1: { command: "echo one", output: "one\ntwo\n", done: bashResult } });
  });

  it("bash_done without output creates the run", () => {
    const s = reduceLive(initialLiveState(), {
      type: "bash_done",
      id: "b2",
      result: bashResult,
      command: "true",
    });
    expect(s.bash.b2).toEqual({ command: "true", output: "", done: bashResult });
  });

  it("entries_appended with the bashExecution entry drops finished runs", () => {
    const s = reduceAll([
      { type: "bash_done", id: "b1", result: bashResult, command: "echo one" },
      { type: "bash_output", id: "b2", delta: "x", command: "sleep 9" },
      {
        type: "entries_appended",
        entries: [
          messageEntry("e", {
            role: "bashExecution",
            command: "echo one",
            output: "one\n",
            exitCode: 0,
            cancelled: false,
            truncated: false,
            timestamp: 1,
          }),
        ],
        leafId: "e",
      },
    ]);
    expect(Object.keys(s.bash)).toEqual(["b2"]);
  });
});

describe("transcript_reset", () => {
  it("clears streaming, pendingUser, finished tools and bash runs; keeps running ones", () => {
    const s = reduceAll([
      pi({ type: "message_start", message: user }),
      pi({ type: "message_start", message: assistant() }),
      pi({ type: "tool_execution_start", toolCallId: "run", toolName: "bash", args: {} }),
      pi({ type: "tool_execution_start", toolCallId: "fin", toolName: "bash", args: {} }),
      pi({
        type: "tool_execution_end",
        toolCallId: "fin",
        toolName: "bash",
        result: {},
        isError: false,
      }),
      { type: "curator", toolCallId: "fin", url: "u1" },
      { type: "curator", toolCallId: "run", url: "u2" },
      { type: "bash_done", id: "b1", result: bashResult, command: "x" },
      { type: "bash_output", id: "b2", delta: "y", command: "y" },
      { type: "transcript_reset", transcript: { entries: [], leafId: null }, state: state0 },
    ]);
    expect(s.streaming).toBeUndefined();
    expect(s.pendingUser).toBeUndefined();
    expect(Object.keys(s.tools)).toEqual(["run"]);
    expect(s.curator).toEqual({ run: "u2" });
    expect(Object.keys(s.bash)).toEqual(["b2"]);
  });

  it("drops a settled run's lastError (e.g. a failed /compact before a fork)", () => {
    const reset: ServerEvent = {
      type: "transcript_reset",
      transcript: { entries: [], leafId: null },
      state: state0,
    };
    const settled: LiveState = { ...initialLiveState(), run: { active: false, lastError: "x" } };
    expect(reduceLive(settled, reset).run).toEqual({ active: false });
    const active: LiveState = { ...initialLiveState(), run: { active: true, lastError: "x" } };
    expect(reduceLive(active, reset)).toBe(active);
  });
});

describe("live_reset", () => {
  it("drops everything the pi process had in flight; keeps extension UI and the last error", () => {
    const s = reduceAll([
      ui({ method: "setStatus", statusKey: "k", statusText: "on" }),
      ui({ method: "notify", message: "hello" }),
      pi({ type: "agent_start" }),
      pi({ type: "message_start", message: user }),
      pi({ type: "message_start", message: assistant() }),
      pi({ type: "tool_execution_start", toolCallId: "run", toolName: "bash", args: {} }),
      { type: "curator", toolCallId: "run", url: "u" },
      pi({ type: "queue_update", steering: ["s"], followUp: ["f"] }),
      pi({ type: "compaction_start", reason: "threshold" }),
      pi({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 10,
        errorMessage: "e",
      }),
      ui({ method: "confirm", title: "t", message: "m" }),
      { type: "bash_output", id: "b1", delta: "y", command: "sleep 9" },
    ]);
    const withError: LiveState = { ...s, run: { ...s.run, lastError: "boom" } };
    const r = reduceLive(withError, { type: "live_reset" });
    expect(r).toEqual({
      ...initialLiveState(),
      run: { active: false, lastError: "boom" },
      statuses: { k: "on" },
      notices: s.notices,
    });
  });

  it("returns the same state when nothing is in flight", () => {
    const s = reduceAll([ui({ method: "setStatus", statusKey: "k", statusText: "on" })]);
    expect(reduceLive(s, { type: "live_reset" })).toBe(s);
  });
});

describe("bash excludeFromContext", () => {
  it("is recorded from bash_output and kept through bash_done", () => {
    const s = reduceAll([
      { type: "bash_output", id: "b1", delta: "x", command: "ls", excludeFromContext: true },
      { type: "bash_done", id: "b1", result: bashResult },
    ]);
    expect(s.bash.b1).toEqual({
      command: "ls",
      output: "x",
      done: bashResult,
      excludeFromContext: true,
    });
    const plain = reduceLive(initialLiveState(), {
      type: "bash_done",
      id: "b2",
      result: bashResult,
      command: "ls",
    });
    expect(plain.bash.b2).not.toHaveProperty("excludeFromContext");
  });
});
