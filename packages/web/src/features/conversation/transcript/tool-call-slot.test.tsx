import { initialLiveState, type SessionEntry, type ToolRun } from "@pi-code/protocol";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationStoreProvider } from "@/store/context";
import { hydratedStore } from "@/test/render";
import { rowParts } from "@/tools/testing";
import { ToolCallSlot } from "./tool-call-slot";

const ARGS = { command: "pnpm test" };

function call(): SessionEntry {
  return {
    type: "message",
    id: "a1",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "bash", arguments: ARGS }],
      stopReason: "toolUse",
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function result(durationMs?: number): SessionEntry {
  return {
    type: "message",
    id: "r1",
    parentId: "a1",
    timestamp: new Date(0).toISOString(),
    message: {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 0,
      ...(durationMs !== undefined && { durationMs }),
    },
  } as unknown as SessionEntry;
}

function renderSlot(entries: SessionEntry[], tools: Record<string, ToolRun> = {}) {
  const store = hydratedStore({
    transcript: { entries, leafId: entries.at(-1)?.id ?? null },
    live: { ...initialLiveState(), run: { active: true }, tools },
  });
  render(
    <ConversationStoreProvider store={store}>
      <ToolCallSlot toolCallId="t1" toolName="bash" args={ARGS} />
    </ConversationStoreProvider>,
  );
  return store;
}

const tail = () => rowParts(screen.getByTestId("tool-call")).tail;

afterEach(() => {
  vi.useRealTimers();
});

describe("ToolCallSlot duration", () => {
  it("a committed call shows its result's durationMs", () => {
    renderSlot([call(), result(1234)]);
    expect(tail()).toBe("1.2s");
  });

  it("before the commit: the live run's elapsed time, then its durationMs", () => {
    vi.useFakeTimers({ now: 10_000 });
    const store = renderSlot([call()], {
      t1: { toolName: "bash", args: ARGS, status: "running", startedAt: 7_000 },
    });
    expect(tail()).toBe("3s");
    act(() => vi.advanceTimersByTime(1000));
    expect(tail()).toBe("4s");
    act(() => {
      store.setState((s) => ({
        live: {
          ...s.live,
          tools: {
            t1: {
              toolName: "bash",
              args: ARGS,
              status: "done",
              startedAt: 7_000,
              durationMs: 2900,
            },
          },
        },
      }));
    });
    expect(tail()).toBe("2.9s");
  });

  it("stops ticking once committed, even while the live run lingers", () => {
    vi.useFakeTimers({ now: 10_000 });
    renderSlot([call(), result()], {
      t1: { toolName: "bash", args: ARGS, status: "running", startedAt: 7_000 },
    });
    expect(screen.getByTestId("tool-call")).toHaveAttribute("data-status", "done");
    expect(tail()).toBe("");
    act(() => vi.advanceTimersByTime(3000));
    expect(tail()).toBe("");
  });
});
