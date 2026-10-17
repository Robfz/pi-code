import {
  activeBranch,
  initialLiveState,
  type LiveState,
  reduceLive,
  type StreamingMessage,
} from "@pi-code/protocol";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ConversationStoreProvider } from "@/store/context";
import type { ConversationStore } from "@/store/conversation-store";
import type { Step } from "@/store/turns";
import { fixtureEvents, fixtureTranscript } from "@/test/fixtures";
import { hydratedStore } from "@/test/render";
import { streamingSteps, useLiveSteps } from "./live-steps";

const keys = (message: StreamingMessage) => streamingSteps(message).map((step) => step.key);

describe("streamingSteps", () => {
  it("is empty without a streaming message", () => {
    expect(streamingSteps(undefined)).toEqual([]);
  });

  it("keys blocks by the message timestamp and index, `live:` without a timestamp", () => {
    const blocks = () => ({ 0: { type: "text", text: "hi", done: false } }) as const;
    expect(keys({ timestamp: 7, blocks: blocks() })).toEqual(["7:0"]);
    expect(keys({ blocks: blocks() })).toEqual(["live:0"]);
  });

  it("drops blank text, streaming or done", () => {
    const steps = streamingSteps({
      timestamp: 1,
      blocks: {
        0: { type: "text", text: "", done: false },
        1: { type: "text", text: " \n\t ", done: false },
        2: { type: "text", text: "\n", done: true },
        3: { type: "text", text: " answer ", done: false },
        4: { type: "text", text: "done", done: true },
      },
    });
    expect(steps).toEqual([
      { kind: "text", key: "1:3", text: " answer ", streaming: true },
      { kind: "text", key: "1:4", text: "done", streaming: false },
    ]);
  });

  it("drops thinking only once it's done and blank", () => {
    const steps = streamingSteps({
      timestamp: 1,
      blocks: {
        0: { type: "thinking", text: "  ", done: true, startedAt: 10, endedAt: 20 },
        1: { type: "thinking", text: "", done: false, startedAt: 30 },
        2: { type: "thinking", text: "hmm", done: true, startedAt: 40, endedAt: 50 },
      },
    });
    expect(steps).toEqual([
      {
        kind: "thinking",
        key: "1:1",
        text: "",
        redacted: false,
        live: true,
        startedAt: 30,
        endedAt: undefined,
      },
      {
        kind: "thinking",
        key: "1:2",
        text: "hmm",
        redacted: false,
        live: false,
        startedAt: 40,
        endedAt: 50,
      },
    ]);
  });

  it("keys a tool call without an id yet by its index, streaming until the call is parsed", () => {
    const call = { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } } as const;
    const steps = streamingSteps({
      timestamp: 1,
      blocks: {
        0: { type: "toolCall", id: "", name: "", argsText: '{"pa' },
        1: { type: "toolCall", id: "t1", name: "read", argsText: '{"path":"a.ts"}', call },
      },
    });
    expect(steps).toEqual([
      {
        kind: "tool",
        key: "pending-0",
        toolCallId: "",
        toolName: "",
        args: undefined,
        argsText: '{"pa',
        streaming: true,
      },
      {
        kind: "tool",
        key: "t1",
        toolCallId: "t1",
        toolName: "read",
        args: { path: "a.ts" },
        argsText: '{"path":"a.ts"}',
        streaming: false,
      },
    ]);
  });

  it("orders blocks by numeric index, sparse indexes included", () => {
    const text = (t: string) => ({ type: "text", text: t, done: false }) as const;
    expect(keys({ timestamp: 1, blocks: { 10: text("c"), 2: text("b"), 0: text("a") } })).toEqual([
      "1:0",
      "1:2",
      "1:10",
    ]);
  });
});

describe("streamingSteps across deltas", () => {
  it("keeps a finished block's step while a later block streams", () => {
    let state = initialLiveState();
    const thoughts = new Set<Step>();
    const texts = new Set<Step>();
    for (const event of fixtureEvents("plain-answer")) {
      state = reduceLive(state, event);
      for (const step of streamingSteps(state.streaming)) {
        if (step.kind === "thinking" && !step.live) thoughts.add(step);
        if (step.kind === "text") texts.add(step);
      }
    }
    expect(texts.size).toBeGreaterThan(1);
    expect(thoughts.size).toBe(1);
  });

  it("gives a changed block a new step", () => {
    const first = { type: "text", text: "a", done: false } as const;
    const before = streamingSteps({ timestamp: 1, blocks: { 0: first } });
    const after = streamingSteps({ timestamp: 1, blocks: { 0: { ...first, text: "ab" } } });
    expect(streamingSteps({ timestamp: 1, blocks: { 0: first } })[0]).toBe(before[0]);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0]).toMatchObject({ text: "ab" });
  });
});

function renderLiveSteps(store: ConversationStore, enabled = true) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(ConversationStoreProvider, { store, children });
  return renderHook(() => useLiveSteps(enabled), { wrapper });
}

describe("useLiveSteps", () => {
  const transcript = fixtureTranscript("tool-calls");
  const committedCall = activeBranch(transcript)
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
    .flatMap((message) => (message.role === "assistant" ? message.content : []))
    .find((block) => block.type === "toolCall");
  if (committedCall?.type !== "toolCall") throw new Error("fixture has no tool call");

  const live = (patch: Partial<LiveState>) =>
    hydratedStore({ transcript, live: { ...initialLiveState(), ...patch } });

  it("adds orphan tools after the streaming blocks, not committed or streaming ones", () => {
    const store = live({
      run: { active: true },
      streaming: {
        timestamp: 5,
        blocks: {
          0: { type: "text", text: "checking", done: true },
          1: { type: "toolCall", id: "s1", name: "bash", argsText: "" },
        },
      },
      tools: {
        [committedCall.id]: { toolName: "read", args: {}, status: "running" },
        s1: { toolName: "bash", args: {}, status: "running" },
        o1: { toolName: "grep", args: { pattern: "x" }, status: "error" },
      },
    });
    const { result } = renderLiveSteps(store);
    expect(result.current.active).toBe(true);
    expect(result.current.steps.map((step) => step.key)).toEqual(["5:0", "s1", "o1"]);
    expect(result.current.steps[2]).toEqual({
      kind: "tool",
      key: "o1",
      toolCallId: "o1",
      toolName: "grep",
      args: { pattern: "x" },
    });
    expect([...result.current.failed]).toEqual(["o1"]);
  });

  it("is empty and inactive when not enabled", () => {
    const store = live({
      run: { active: true },
      streaming: { timestamp: 5, blocks: { 0: { type: "text", text: "x", done: false } } },
    });
    const { result } = renderLiveSteps(store, false);
    expect(result.current).toEqual({ active: false, steps: [], failed: new Set() });
  });
});
