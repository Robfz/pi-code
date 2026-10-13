import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { SubagentResult } from "@/lib/subagent-details";
import { formatUsage, subagentStatus } from "./subagent";
import { fixtureToolCall, propsAt, rowParts } from "./testing";
import { ToolCallView } from "./tool-call-view";

const row = () => screen.getByTestId("tool-call");
const header = () => row().firstElementChild as HTMLElement;
const expand = () => userEvent.setup().click(header());
const label = () => rowParts(row());

describe("subagent (subagent fixture)", () => {
  const call = fixtureToolCall("subagent", "spawn");

  it("has five live updates and a final result", () => {
    expect(call.updates).toHaveLength(5);
    expect(call.result).toBeDefined();
  });

  it("shows the task before any details arrive", async () => {
    render(<ToolCallView {...propsAt(call, "start")} />);
    expect(label()).toMatchObject({
      icon: "bot",
      verb: "Running",
      shimmer: true,
      target: "1 agent",
      meta: undefined,
    });
    expect(header()).toHaveAttribute("aria-expanded", "false");
    await expand();
    expect(screen.getByText("Read a.txt and reply with its contents")).toBeInTheDocument();
    expect(screen.getByText("Starting…")).toBeInTheDocument();
  });

  it("live: a running card that picks up nested tool calls as rows, and output", async () => {
    const { rerender } = render(<ToolCallView {...propsAt(call, { update: 0 })} />);
    await expand();
    const card = () => screen.getByTestId("subagent-card");
    expect(card()).toHaveAttribute("data-status", "running");
    expect(label()).toMatchObject({ verb: "Running", target: "1 agent" });
    expect(within(card()).getByText("tiny")).toBeInTheDocument();
    expect(within(card()).getByText("project")).toBeInTheDocument();
    expect(within(card()).getByText("Running…")).toBeInTheDocument();
    expect(within(card()).getByText("claude-haiku-4-5")).toBeInTheDocument();

    // Update 2: first turn done, the read call is visible.
    rerender(<ToolCallView {...propsAt(call, { update: 2 })} />);
    expect(card()).toHaveAttribute("data-status", "running");
    const nested = within(card()).getAllByTestId("nested-tool-call");
    expect(nested).toHaveLength(1);
    // Running until the agent's messages hold its result.
    expect(rowParts(nested[0] as HTMLElement)).toMatchObject({
      icon: "file-text",
      verb: "Reading",
      shimmer: true,
      target: "a.txt",
    });
    // Body-less: no toggle.
    expect(within(nested[0] as HTMLElement).queryByRole("button")).toBeNull();
    expect(card()).toHaveTextContent("1 turn ↑1.9k ↓171 $0.0028 ctx:2.1k");

    // Update 4: the answer streams in, still no duration.
    rerender(<ToolCallView {...propsAt(call, { update: 4 })} />);
    expect(card()).toHaveAttribute("data-status", "running");
    expect(within(card()).getByText(/The contents of a\.txt/)).toBeInTheDocument();
    expect(rowParts(within(card()).getByTestId("nested-tool-call"))).toMatchObject({
      verb: "Read",
      shimmer: false,
    });
  });

  it("final: done card with duration, usage and markdown output (collapsed until expanded)", async () => {
    render(<ToolCallView {...propsAt(call, "end")} />);
    expect(label()).toMatchObject({ verb: "Ran", shimmer: false, target: "1 agent" });
    expect(screen.queryByTestId("subagent-card")).toBeNull();
    await expand();
    const card = screen.getByTestId("subagent-card");
    expect(card).toHaveAttribute("data-status", "done");
    expect(within(card).getByLabelText("Done")).toBeInTheDocument();
    expect(within(card).getByText("19.5s")).toBeInTheDocument();
    expect(card).toHaveTextContent("2 turns ↑4.1k ↓224 $0.0052 ctx:2.2k · claude-haiku-4-5");
    expect(rowParts(within(card).getByTestId("nested-tool-call"))).toMatchObject({
      verb: "Read",
      target: "a.txt",
    });
    expect(await within(card).findByText(/alpha: the first file/)).toBeInTheDocument();
  });
});

function result(patch: Partial<SubagentResult>): SubagentResult {
  return {
    agent: "scout",
    agentSource: "user",
    task: "look around",
    exitCode: 0,
    messages: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    ...patch,
  };
}

describe("subagent modes", () => {
  it("nested calls without a result run while their agent does", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "n1", name: "bash", arguments: { command: "ls" } }],
      },
    ];
    const props = {
      toolCallId: "n",
      toolName: "spawn",
      args: { agent: "scout", task: "look" },
      isError: false,
    };
    const { rerender } = render(
      <ToolCallView
        {...props}
        status="running"
        partialResult={{
          content: [],
          details: { mode: "single", results: [result({ messages, durationMs: undefined })] },
        }}
      />,
    );
    await expand();
    const nested = () => rowParts(screen.getByTestId("nested-tool-call"));
    expect(nested()).toMatchObject({ icon: "square-terminal", verb: "Running", shimmer: true });
    rerender(
      <ToolCallView
        {...props}
        status="done"
        result={{
          content: [],
          details: {
            mode: "single",
            results: [
              result({
                durationMs: 10,
                messages: [
                  ...messages,
                  {
                    role: "toolResult",
                    toolCallId: "n1",
                    content: [{ type: "text", text: "boom" }],
                    isError: true,
                  },
                ],
              }),
            ],
          },
        }}
      />,
    );
    expect(nested()).toMatchObject({
      icon: "circle-alert",
      verb: "Command failed",
      target: "ls",
      meta: "boom",
    });
  });

  it("parallel: placeholders run until each task finishes", async () => {
    const details = {
      mode: "parallel",
      agentScope: "user",
      projectAgentsDir: null,
      results: [
        result({
          agent: "scout",
          exitCode: 0,
          durationMs: 1200,
          messages: [{ role: "assistant", content: [{ type: "text", text: "found it" }] }],
        }),
        result({ agent: "worker", agentSource: "unknown", exitCode: -1 }),
      ],
    };
    render(
      <ToolCallView
        toolCallId="p1"
        toolName="spawn"
        args={{
          tasks: [
            { agent: "scout", task: "a" },
            { agent: "worker", task: "b" },
          ],
        }}
        status="running"
        isError={false}
        partialResult={{
          content: [{ type: "text", text: "Parallel: 1/2 done, 1 running..." }],
          details,
        }}
      />,
    );
    expect(label()).toMatchObject({
      verb: "Running",
      target: "2 agents",
      meta: "· 1/2 done, 1 running",
    });
    await expand();
    const cards = screen.getAllByTestId("subagent-card");
    expect(cards.map((c) => c.dataset.status)).toEqual(["done", "running"]);
    expect(within(cards[0] as HTMLElement).getByText("found it")).toBeInTheDocument();
  });

  it("chain: failed step shows its stop reason and error", async () => {
    const details = {
      mode: "chain",
      results: [
        result({ agent: "planner", step: 1, durationMs: 500 }),
        result({
          agent: "worker",
          step: 2,
          exitCode: 1,
          durationMs: 300,
          stopReason: "error",
          errorMessage: "model overloaded",
        }),
      ],
    };
    render(
      <ToolCallView
        toolCallId="c1"
        toolName="spawn"
        args={{
          chain: [
            { agent: "planner", task: "plan" },
            { agent: "worker", task: "{previous}" },
          ],
        }}
        status="error"
        isError
        result={{
          content: [{ type: "text", text: "Chain stopped at step 2 (worker): model overloaded" }],
          details,
        }}
      />,
    );
    expect(label()).toMatchObject({
      icon: "circle-alert",
      verb: "Agents failed",
      target: "2 agents",
      meta: "· 1/2 steps · Chain stopped at step 2 (worker): model overloaded",
    });
    await expand();
    const cards = screen.getAllByTestId("subagent-card");
    expect(cards.map((c) => c.dataset.status)).toEqual(["done", "failed"]);
    expect(within(cards[0] as HTMLElement).getByText("Step 1")).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText("error")).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText("model overloaded")).toBeInTheDocument();
    expect(
      screen.getByText("Chain stopped at step 2 (worker): model overloaded"),
    ).toBeInTheDocument();
  });

  it("no details: falls back to the result text", async () => {
    render(
      <ToolCallView
        toolCallId="x"
        toolName="spawn"
        args={{}}
        status="done"
        isError={false}
        result={{
          content: [{ type: "text", text: "Invalid parameters. Provide exactly one mode." }],
        }}
      />,
    );
    await expand();
    expect(screen.getByText("Invalid parameters. Provide exactly one mode.")).toBeInTheDocument();
  });

  it("ultraspawn: the whole row gets the ultraspawn tone and a tinted icon", () => {
    const { rerender } = render(
      <ToolCallView
        toolCallId="x"
        toolName="spawn"
        args={{ ultraspawn: "review" }}
        status="running"
        isError={false}
      />,
    );
    expect(row()).toHaveAttribute("data-tone", "ultraspawn");
    expect(header().querySelector('[data-slot="row-icon"] svg')).toHaveClass("text-ultraspawn");
    expect(header().querySelector('[data-slot="row-verb"]')).toHaveClass(
      "shimmer",
      "shimmer-ultraspawn",
    );

    rerender(
      <ToolCallView
        toolCallId="x"
        toolName="spawn"
        args={{ ultraspawn: "review" }}
        status="done"
        isError={false}
      />,
    );
    expect(header().querySelector('[data-slot="row-verb"]')).toHaveClass("text-ultraspawn");

    rerender(
      <ToolCallView
        toolCallId="x"
        toolName="spawn"
        args={{ agent: "scout", task: "t" }}
        status="running"
        isError={false}
      />,
    );
    expect(row()).not.toHaveAttribute("data-tone");
  });

  it("ultraspawn running: progress meta, phases, agents (running, then failed) and recent logs", async () => {
    const agent = (id: number, patch: Record<string, unknown>) => ({
      id,
      agent: "worker",
      phase: "fix",
      phaseIndex: 1,
      status: "queued",
      attempts: 0,
      cost: 0,
      ...patch,
    });
    const details = {
      mode: "ultraspawn",
      runId: "r",
      name: "review",
      source: "user",
      script: "",
      args: {},
      status: "running",
      phases: [
        {
          name: "scan",
          status: "done",
          startedAt: 0,
          endedAt: 2500,
          spawned: 2,
          done: 1,
          failed: 1,
        },
        { name: "fix", status: "running", startedAt: 2500, spawned: 1, done: 0, failed: 0 },
      ],
      agents: [
        agent(0, {
          agent: "scout",
          label: "frontend",
          phase: "scan",
          phaseIndex: 0,
          status: "done",
          startedAt: 0,
          endedAt: 1200,
          attempts: 1,
          cost: 0.01,
        }),
        ...Array.from({ length: 7 }, (_, i) => agent(3 + i, {})),
        agent(2, { status: "running", startedAt: Date.now(), attempts: 1, isolated: true }),
        agent(1, {
          agent: "scout",
          phase: "scan",
          phaseIndex: 0,
          status: "failed",
          reason: "timeout",
          error: "no answer\nstack",
          startedAt: 0,
          endedAt: 2000,
          attempts: 2,
          cost: 0.02,
        }),
      ],
      spawned: 3,
      logs: ["l1", "l2", "l3", "l4", "l5", "l6", "l7"],
      results: [{ usage: { cost: 0.01 } }, { usage: { cost: 0.02 } }],
      startedAt: Date.now() - 65_000,
    };
    render(
      <ToolCallView
        toolCallId="u1"
        toolName="spawn"
        args={{ ultraspawn: "review" }}
        status="running"
        isError={false}
        partialResult={{ content: [{ type: "text", text: "running" }], details }}
      />,
    );
    expect(row()).toHaveAttribute("data-tone", "ultraspawn");
    expect(label()).toMatchObject({
      verb: "Running",
      target: "10 agents",
      meta: "· 1/10 done · 1 failed · $0.0300",
    });
    await expand();
    expect(screen.queryByText("Starting…")).toBeNull();
    expect(screen.getByTestId("ultraspawn-header")).toHaveTextContent(
      "review · running · 1 done · 1 failed · 1 running · 7 queued · 3 spawned · $0.0300 · 1m 5s",
    );
    const phases = screen.getAllByTestId("ultraspawn-phase");
    expect(phases[0]).toHaveTextContent("scan2/21 failed2.5s");
    expect(within(phases[1] as HTMLElement).getByLabelText("Running")).toBeInTheDocument();
    expect(phases[1]).toHaveTextContent("fix0/8");

    const agents = within(screen.getByTestId("ultraspawn-agents")).getAllByTestId(
      "ultraspawn-agent",
    );
    expect(agents).toHaveLength(8);
    expect(agents.map((a) => a.dataset.status).slice(0, 3)).toEqual(["running", "failed", "done"]);
    expect(agents[0]).toHaveTextContent("isolated");
    expect(agents[1]).toHaveTextContent("2×");
    expect(agents[1]).toHaveTextContent("timeout: no answer");
    expect(agents[1]).not.toHaveTextContent("stack");
    expect(agents[2]).toHaveTextContent("scoutfrontendscan$0.01001.2s");
    expect(screen.getByText("2 more agents")).toBeInTheDocument();

    const logs = screen.getByTestId("ultraspawn-logs");
    expect(within(logs).getByText("2 earlier log lines")).toBeInTheDocument();
    expect(within(logs).getByText("l7")).toBeInTheDocument();
    expect(within(logs).queryByText("l1")).toBeNull();
  });

  it("ultraspawn finished: the result text under the agent summary", async () => {
    const details = {
      mode: "ultraspawn",
      name: "inline",
      status: "done",
      phases: [],
      agents: [
        {
          id: 0,
          agent: "scout",
          status: "done",
          startedAt: 0,
          endedAt: 3000,
          attempts: 1,
          cost: 0.5,
        },
      ],
      spawned: 1,
      logs: [],
      results: [{ usage: { cost: 0.5 } }],
      startedAt: 0,
      endedAt: 4000,
    };
    render(
      <ToolCallView
        toolCallId="u2"
        toolName="spawn"
        args={{ script: "return 1" }}
        status="done"
        isError={false}
        result={{
          content: [{ type: "text", text: "Ultraspawn inline finished\n\nall good" }],
          details,
        }}
      />,
    );
    expect(label()).toMatchObject({
      verb: "Ran",
      target: "1 agent",
      meta: "· 1/1 done · $0.5000",
    });
    await expand();
    expect(screen.getByTestId("ultraspawn-header")).toHaveTextContent(
      "inline · done · 1 done · 0 failed · 0 running · 1 spawned · $0.5000 · 4.0s",
    );
    expect(screen.getByTestId("ultraspawn-agent")).toHaveTextContent("3.0s");
    expect(screen.queryByTestId("ultraspawn-phases")).toBeNull();
    expect(screen.queryByTestId("ultraspawn-logs")).toBeNull();
    expect(screen.getByText(/all good/)).toBeInTheDocument();
  });

  it("ultraspawn interrupted: agents left running read as failed, not spinning", async () => {
    const details = {
      mode: "ultraspawn",
      name: "inline",
      status: "running",
      phases: [{ name: "scan", status: "running", startedAt: 0 }],
      agents: [
        {
          id: 0,
          agent: "scout",
          phaseIndex: 0,
          status: "running",
          startedAt: 0,
          attempts: 1,
          cost: 0,
        },
      ],
      spawned: 1,
      logs: [],
      results: [],
      startedAt: 0,
    };
    render(
      <ToolCallView
        toolCallId="u3"
        toolName="spawn"
        args={{ script: "return 1" }}
        status="error"
        isError
        partialResult={{ content: [{ type: "text", text: "" }], details }}
      />,
    );
    await expand();
    expect(screen.getByTestId("ultraspawn-header")).toHaveTextContent(
      "inline · running · 0 done · 1 failed · 0 running · 1 spawned · $0.0000",
    );
    const agent = screen.getByTestId("ultraspawn-agent");
    expect(agent).toHaveAttribute("data-status", "failed");
    expect(agent).toHaveTextContent("interrupted");
    expect(screen.queryByLabelText("Running")).toBeNull();
    expect(screen.getByTestId("ultraspawn-phase")).toHaveTextContent("scan1/11 failed");
  });

  it("ultraspawn canceled: the header is just name and status", async () => {
    const details = {
      mode: "ultraspawn",
      name: "inline",
      status: "canceled",
      phases: [],
      agents: [],
      spawned: 0,
      logs: [],
      results: [],
      startedAt: 0,
    };
    render(
      <ToolCallView
        toolCallId="u4"
        toolName="spawn"
        args={{ script: "return 1" }}
        status="done"
        isError={false}
        result={{
          content: [{ type: "text", text: "Canceled: ultraspawn not approved." }],
          details,
        }}
      />,
    );
    await expand();
    expect(screen.getByTestId("ultraspawn-header")).toHaveTextContent(/^inline · canceled$/);
  });

  it("status and usage helpers", () => {
    expect(subagentStatus(result({ exitCode: -1 }), false)).toBe("failed");
    expect(subagentStatus(result({ stopReason: "aborted", durationMs: 1 }), false)).toBe("failed");
    expect(subagentStatus(result({}), false)).toBe("done");
    expect(formatUsage({ turns: 1, input: 12_345, output: 1_500_000, cost: 0.5 })).toBe(
      "1 turn ↑12k ↓1.5M $0.5000",
    );
  });
});
