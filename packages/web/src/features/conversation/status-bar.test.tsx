import {
  initialLiveState,
  type LiveState,
  type RpcSessionState,
  type SessionStats,
} from "@pi-code/protocol";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAgent } from "@/test/fixtures";
import { hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import { ActionSheets } from "./action-sheets";
import { useConversationUi } from "./conversation-ui";
import { contextCells, StatusBar } from "./status-bar";

type Model = NonNullable<RpcSessionState["model"]>;

function model(provider: string, id: string, patch: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider,
    baseUrl: "",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...patch,
  } as Model;
}

function state(patch: Partial<RpcSessionState> = {}): RpcSessionState {
  return {
    model: model("anthropic", "claude-sonnet-4-5"),
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "all",
    sessionId: "s1",
    sessionName: "Refactor auth",
    autoCompactionEnabled: true,
    messageCount: 4,
    pendingMessageCount: 0,
    ...patch,
  };
}

function stats(patch: Partial<SessionStats> = {}): SessionStats {
  return {
    sessionFile: "/home/me/.pi/sessions/s1.jsonl",
    sessionId: "s1",
    userMessages: 2,
    assistantMessages: 3,
    toolCalls: 5,
    toolResults: 5,
    totalMessages: 10,
    tokens: { input: 12_000, output: 3_400, cacheRead: 50_000, cacheWrite: 1_000, total: 66_400 },
    cost: 0.4567,
    contextUsage: { tokens: 90_000, contextWindow: 200_000, percent: 45 },
    ...patch,
  };
}

beforeEach(() => {
  useConversationUi.getState().reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("contextCells", () => {
  it("maps percentages to 5 cells, null-safe", () => {
    expect(contextCells(null)).toBe(0);
    expect(contextCells(undefined)).toBe(0);
    expect(contextCells(0)).toBe(0);
    expect(contextCells(1)).toBe(1);
    expect(contextCells(45)).toBe(3);
    expect(contextCells(100)).toBe(5);
    expect(contextCells(140)).toBe(5);
  });
});

describe("StatusBar", () => {
  it("shows folder, branch + dirty dot, context, cost and chips, without model, thinking or name", async () => {
    stubFetch();
    const live: LiveState = { ...initialLiveState(), statuses: { mcp: "MCP: 2 servers" } };
    const store = hydratedStore({
      agent: makeAgent({ cwd: "/home/me/pi-code" }),
      state: state(),
      stats: stats(),
      gitStatus: { branch: "main", dirty: true },
      live,
    });
    await renderWithStore(<StatusBar />, store);
    const bar = screen.getByTestId("status-bar");
    expect(within(bar).getByTestId("status-folder")).toHaveTextContent("pi-code");
    expect(within(bar).getByTestId("status-branch")).toHaveTextContent("main");
    expect(within(bar).getByTestId("status-dirty")).toBeInTheDocument();
    expect(within(bar).getByTestId("context-bar")).toHaveAttribute("data-filled", "3");
    expect(within(bar).getByTestId("context-bar")).toHaveTextContent("45%");
    expect(bar).not.toHaveTextContent("Refactor auth");
    expect(bar).not.toHaveTextContent("claude-sonnet-4-5");
    expect(bar).not.toHaveTextContent("medium");
    expect(
      within(bar)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Session stats", "Cost $0.457"]);
    expect(within(bar).getByRole("button", { name: "Cost $0.457" })).toHaveTextContent(
      /^\$0\.457$/,
    );
    expect(screen.getByTestId("status-chips")).toHaveTextContent("MCP: 2 servers");
    expect(screen.queryByTestId("run-indicator")).toBeNull();
  });

  it("shows subagent spend next to the cost once a subagent call exists", async () => {
    stubFetch();
    const live: LiveState = {
      ...initialLiveState(),
      tools: {
        t1: {
          toolName: "spawn",
          args: {},
          status: "running",
          partialResult: { details: { mode: "single", results: [{ usage: { cost: 0.12 } }] } },
        },
      },
    };
    await renderWithStore(<StatusBar />, hydratedStore({ state: state(), stats: stats(), live }));
    const cost = screen.getByRole("button", { name: "Cost $0.457, subagents $0.120" });
    expect(cost).toHaveTextContent("$0.457 (sa $0.120)");
  });

  it("is null-safe before state and stats arrive, and without a repo", async () => {
    stubFetch();
    await renderWithStore(<StatusBar />, hydratedStore({ gitStatus: null }));
    const bar = screen.getByTestId("status-bar");
    expect(within(bar).queryByTestId("status-branch")).toBeNull();
    expect(within(bar).getByTestId("context-bar")).toHaveAttribute("data-filled", "0");
    expect(within(bar).getByTestId("context-bar")).toHaveTextContent("?");
    expect(within(bar).queryByRole("button", { name: /Cost/ })).toBeNull();
  });

  it("unknown context percent (after compaction) shows empty cells", async () => {
    stubFetch();
    await renderWithStore(
      <StatusBar />,
      hydratedStore({
        state: state(),
        stats: stats({ contextUsage: { tokens: null, contextWindow: 200_000, percent: null } }),
      }),
    );
    expect(screen.getByTestId("context-bar")).toHaveAttribute("data-filled", "0");
  });

  it("clean repo: no dirty dot", async () => {
    stubFetch();
    await renderWithStore(
      <StatusBar />,
      hydratedStore({ gitStatus: { branch: "feature/x", dirty: false } }),
    );
    expect(screen.getByTestId("status-branch")).toHaveTextContent("feature/x");
    expect(screen.queryByTestId("status-dirty")).toBeNull();
  });

  it.each([
    ["running", { run: { active: true } }],
    ["compacting", { run: { active: true, compaction: { reason: "manual" as const } } }],
    [
      "retrying",
      {
        run: {
          active: true,
          retry: { attempt: 2, maxAttempts: 3, delayMs: 1000, errorMessage: "529", startedAt: 0 },
        },
      },
    ],
  ])("reads Working while %s", async (_, patch) => {
    stubFetch();
    await renderWithStore(
      <StatusBar />,
      hydratedStore({ state: state(), live: { ...initialLiveState(), ...patch } }),
    );
    expect(screen.getByTestId("run-indicator")).toHaveTextContent(/^Working$/);
    // Last on the line, after the context bar and the cost.
    expect(screen.getByTestId("status-bar").lastElementChild).toBe(
      screen.getByTestId("run-indicator"),
    );
  });

  it("the context bar opens the stats sheet with get_session_stats values", async () => {
    stubFetch((call) =>
      call.url === "/api/agents/a1/rpc"
        ? [200, { data: stats({ cost: 1.5, userMessages: 7 }) }]
        : undefined,
    );
    await renderWithStore(
      <>
        <StatusBar />
        <ActionSheets />
      </>,
      hydratedStore({ state: state(), stats: stats() }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Session stats" }));
    const sheet = await screen.findByTestId("stats-sheet");
    await within(sheet).findByText("$1.50");
    expect(sheet).toHaveTextContent("7 user · 3 assistant · 10 total");
    expect(sheet).toHaveTextContent("90k / 200k (45%)");
    expect(sheet).toHaveTextContent("/home/me/.pi/sessions/s1.jsonl");
  });
});
