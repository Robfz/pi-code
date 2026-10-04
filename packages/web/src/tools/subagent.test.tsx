import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { SubagentResult } from "@/lib/subagent-details";
import { agentStatus, formatUsage } from "./subagent";
import { fixtureToolCall, propsAt } from "./testing";
import { ToolCallView } from "./tool-call-view";

const header = () => screen.getByTestId("tool-call").firstElementChild as HTMLElement;

describe("subagent (subagent fixture)", () => {
  const call = fixtureToolCall("subagent", "subagent");

  it("has five live updates and a final result", () => {
    expect(call.updates).toHaveLength(5);
    expect(call.result).toBeDefined();
  });

  it("shows the task before any details arrive", () => {
    render(<ToolCallView {...propsAt(call, "start")} />);
    expect(header()).toHaveTextContent("single · tiny");
    expect(screen.getByText("Read a.txt and reply with its contents")).toBeInTheDocument();
    expect(screen.getByText("Starting…")).toBeInTheDocument();
  });

  it("live: a running card that picks up nested tool calls and output", () => {
    const { rerender } = render(<ToolCallView {...propsAt(call, { update: 0 })} />);
    const card = () => screen.getByTestId("subagent-card");
    expect(card()).toHaveAttribute("data-status", "running");
    expect(header()).toHaveTextContent("single · tiny · running");
    expect(within(card()).getByText("tiny")).toBeInTheDocument();
    expect(within(card()).getByText("project")).toBeInTheDocument();
    expect(within(card()).getByText("Running…")).toBeInTheDocument();
    expect(within(card()).getByText("claude-haiku-4-5")).toBeInTheDocument();

    // Update 2: first turn done, the read call is visible.
    rerender(<ToolCallView {...propsAt(call, { update: 2 })} />);
    expect(card()).toHaveAttribute("data-status", "running");
    const tools = within(card()).getByTestId("subagent-tools");
    expect(tools).toHaveTextContent("→ read a.txt");
    expect(card()).toHaveTextContent("1 turn ↑1.9k ↓174 $0.0028 ctx:2.1k");

    // Update 4: the answer streams in, still no duration.
    rerender(<ToolCallView {...propsAt(call, { update: 4 })} />);
    expect(card()).toHaveAttribute("data-status", "running");
    expect(within(card()).getByText(/The contents of a\.txt/)).toBeInTheDocument();
  });

  it("final: done card with duration, usage and markdown output (collapsed until expanded)", async () => {
    render(<ToolCallView {...propsAt(call, "end")} />);
    expect(header()).toHaveTextContent("single · tiny · done");
    expect(screen.queryByTestId("subagent-card")).toBeNull();
    await userEvent.setup().click(header());
    const card = screen.getByTestId("subagent-card");
    expect(card).toHaveAttribute("data-status", "done");
    expect(within(card).getByLabelText("Done")).toBeInTheDocument();
    expect(within(card).getByText("18.3s")).toBeInTheDocument();
    expect(card).toHaveTextContent("2 turns ↑4.0k ↓218 $0.0051 ctx:2.1k · claude-haiku-4-5");
    expect(within(card).getByTestId("subagent-tools")).toHaveTextContent("read a.txt");
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
  it("parallel: placeholders run until each task finishes", () => {
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
        toolName="subagent"
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
    expect(header()).toHaveTextContent("parallel · scout, worker · 1/2 done, 1 running");
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
        toolName="subagent"
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
    expect(header()).toHaveTextContent("chain · planner, worker · 1/2 steps");
    await userEvent.setup().click(header());
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
        toolName="subagent"
        args={{}}
        status="done"
        isError={false}
        result={{
          content: [{ type: "text", text: "Invalid parameters. Provide exactly one mode." }],
        }}
      />,
    );
    await userEvent.setup().click(header());
    expect(screen.getByText("Invalid parameters. Provide exactly one mode.")).toBeInTheDocument();
  });

  it("status and usage helpers", () => {
    expect(agentStatus(result({ exitCode: -1 }), false)).toBe("failed");
    expect(agentStatus(result({ stopReason: "aborted", durationMs: 1 }), false)).toBe("failed");
    expect(agentStatus(result({}), false)).toBe("done");
    expect(formatUsage({ turns: 1, input: 12_345, output: 1_500_000, cost: 0.5 })).toBe(
      "1 turn ↑12k ↓1.5M $0.5000",
    );
  });
});
