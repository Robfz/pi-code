import {
  initialLiveState,
  type LiveRun,
  type LiveState,
  type SessionEntry,
  type Transcript,
} from "@pi-code/protocol";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationStoreProvider } from "@/store/context";
import { type Density, useUiPrefs } from "@/store/ui-prefs";
import { hydratedStore } from "@/test/render";
import { LiveStatusRow } from "./live-status";

const ACTIVE: LiveRun = { active: true };

function renderRow(
  live: Partial<LiveState>,
  { density = "balanced", transcript }: { density?: Density; transcript?: Transcript } = {},
) {
  useUiPrefs.setState({ density });
  const store = hydratedStore({
    live: { ...initialLiveState(), ...live },
    ...(transcript && { transcript }),
  });
  render(
    <ConversationStoreProvider store={store}>
      <LiveStatusRow />
    </ConversationStoreProvider>,
  );
  return store;
}

const row = () => screen.queryByTestId("live-status");
const phrase = () => row()?.firstElementChild;

const running = (toolName: string, args: unknown): LiveState["tools"] => ({
  t1: { toolName, args, status: "running" },
});

beforeEach(() => {
  useUiPrefs.setState({ density: "balanced" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LiveStatusRow phrase", () => {
  it.each<[string, Partial<LiveState>, string]>([
    [
      "a compaction",
      { run: { active: false, compaction: { reason: "manual" } } },
      "Compacting context",
    ],
    [
      "a retry",
      {
        run: {
          ...ACTIVE,
          retry: {
            attempt: 2,
            maxAttempts: 3,
            delayMs: 1000,
            errorMessage: "overloaded",
            startedAt: 0,
          },
        },
      },
      "Retrying 2/3 · overloaded",
    ],
    [
      "live thinking",
      { run: ACTIVE, streaming: { blocks: { 0: { type: "thinking", text: "Hm", done: false } } } },
      "Thinking",
    ],
    [
      "a running read",
      { run: ACTIVE, tools: running("read", { path: "src/foo.ts" }) },
      "Reading foo.ts",
    ],
    [
      "a running bash",
      { run: ACTIVE, tools: running("bash", { command: "pnpm test" }) },
      "Running pnpm test",
    ],
    ["nothing else", { run: ACTIVE }, "Working"],
  ])("%s", (_, live, expected) => {
    renderRow(live, { density: "compact" });
    expect(phrase()).toHaveTextContent(expected);
    expect(phrase()).toHaveClass("shimmer");
  });

  it("compaction before retry, retry before the rest", () => {
    renderRow(
      {
        run: {
          ...ACTIVE,
          compaction: { reason: "overflow" },
          retry: { attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: "x", startedAt: 0 },
        },
        tools: running("read", { path: "a.ts" }),
      },
      { density: "compact" },
    );
    expect(phrase()).toHaveTextContent("Compacting context");
  });

  it("is absent without a run, a compaction or a retry", () => {
    renderRow({}, { density: "compact" });
    expect(row()).toBeNull();
  });
});

describe("LiveStatusRow visibility", () => {
  const unanswered: Transcript = {
    entries: [
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/x.ts" } }],
          stopReason: "toolUse",
          timestamp: 0,
        },
      } as unknown as SessionEntry,
    ],
    leafId: "a1",
  };

  it.each<[string, Partial<LiveState>, Transcript | undefined]>([
    ["a tool runs", { run: ACTIVE, tools: running("read", { path: "a.ts" }) }, undefined],
    [
      "a call streams",
      {
        run: ACTIVE,
        streaming: {
          blocks: { 0: { type: "toolCall", id: "c2", name: "bash", argsText: '{"comm' } },
        },
      },
      undefined,
    ],
    [
      "thinking is live",
      { run: ACTIVE, streaming: { blocks: { 0: { type: "thinking", text: "Hm", done: false } } } },
      undefined,
    ],
    ["a committed call waits for its result", { run: ACTIVE }, unanswered],
  ])("hidden in Balanced and Detailed while %s, shown in Compact", (_, live, transcript) => {
    for (const density of ["balanced", "detailed"] as const) {
      renderRow(live, { density, transcript });
      expect(row()).toBeNull();
      document.body.innerHTML = "";
    }
    renderRow(live, { density: "compact", transcript });
    expect(row()).not.toBeNull();
  });

  it("shown in Balanced between steps: streaming text, a finished tool", () => {
    renderRow({
      run: ACTIVE,
      streaming: { blocks: { 0: { type: "text", text: "Hello", done: false } } },
      tools: { t1: { toolName: "read", args: { path: "a.ts" }, status: "done" } },
    });
    expect(phrase()).toHaveTextContent("Working");
  });
});

describe("LiveStatusRow timer", () => {
  it("counts from run.startedAt every second", () => {
    vi.useFakeTimers({ now: 100_000 });
    renderRow({ run: { ...ACTIVE, startedAt: 59_000 } });
    expect(screen.getByTestId("live-timer")).toHaveTextContent("· 41s");
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByTestId("live-timer")).toHaveTextContent("· 42s");
  });

  it("is absent without run.startedAt", () => {
    renderRow({ run: ACTIVE });
    expect(row()).not.toBeNull();
    expect(screen.queryByTestId("live-timer")).toBeNull();
  });
});

describe("LiveStatusRow run error", () => {
  it("shows the run's error in an alert once the run is over", () => {
    renderRow({ run: { active: false, lastError: "Extension crashed" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Extension crashed");
    expect(row()).toBeNull();
  });

  it("leaves an assistant error to its message", () => {
    const transcript: Transcript = {
      entries: [
        {
          type: "message",
          id: "a1",
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "rate limited",
            timestamp: 0,
          },
        } as unknown as SessionEntry,
      ],
      leafId: "a1",
    };
    renderRow({ run: { active: false, lastError: "rate limited" } }, { transcript });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
