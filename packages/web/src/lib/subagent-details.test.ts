import { describe, expect, it } from "vitest";
import {
  isUltraspawnCall,
  subagentCost,
  subagentDetails,
  ultraspawnDetails,
} from "./subagent-details";

describe("isUltraspawnCall", () => {
  it("detects the ultraspawn mode from parsed args", () => {
    expect(isUltraspawnCall({ ultraspawn: "review" })).toBe(true);
    expect(isUltraspawnCall({ script: "return 1", args: {} })).toBe(true);
    expect(isUltraspawnCall({ agent: "scout", task: 'echo "script": 1' })).toBe(false);
    expect(isUltraspawnCall({ tasks: [] })).toBe(false);
  });

  it("falls back to the raw JSON while the mode key hasn't parsed", () => {
    expect(isUltraspawnCall(undefined, '{"script": "const r = await ag')).toBe(true);
    expect(isUltraspawnCall({}, '{"ultraspawn":')).toBe(true);
    expect(isUltraspawnCall(undefined, '{"agent": "sc')).toBe(false);
    expect(isUltraspawnCall(undefined)).toBe(false);
  });
});

describe("subagentCost", () => {
  it("sums usage.cost over the call's agents", () => {
    const details = {
      mode: "parallel",
      results: [{ usage: { cost: 0.1 } }, { usage: { cost: 0.02 } }, { agent: "no usage" }],
    };
    expect(subagentCost({ details })).toBeCloseTo(0.12);
  });

  it("counts results without a recognized mode", () => {
    expect(subagentCost({ details: { results: [{ usage: { cost: 0.3 } }] } })).toBeCloseTo(0.3);
  });

  it("is 0 for malformed or missing details", () => {
    expect(subagentCost(undefined)).toBe(0);
    expect(subagentCost({ details: {} })).toBe(0);
    expect(subagentCost({ details: { mode: "single", results: "x" } })).toBe(0);
    expect(subagentCost({ details: { mode: "single", results: [{ usage: { cost: "1" } }] } })).toBe(
      0,
    );
  });
});

describe("ultraspawnDetails", () => {
  const details = {
    mode: "ultraspawn",
    agentScope: "user",
    runId: "r1",
    name: "review",
    source: "user",
    script: "return 1",
    args: {},
    status: "running",
    phases: [
      { name: "scan", status: "done", startedAt: 1, endedAt: 5, spawned: 1, done: 1, failed: 0 },
    ],
    agents: [
      {
        id: 0,
        agent: "scout",
        label: "a",
        phase: "scan",
        phaseIndex: 0,
        status: "failed",
        reason: "timeout",
        error: "took too long",
        startedAt: 1,
        endedAt: 4,
        attempts: 2,
        cost: 0.1,
        isolated: true,
      },
    ],
    spawned: 1,
    logs: ["hello"],
    results: [{ usage: { cost: 0.06 } }, { usage: { cost: 0.04 } }],
    startedAt: 1,
  };

  it("reads the fields the UI shows", () => {
    expect(ultraspawnDetails({ details })).toEqual({
      name: "review",
      status: "running",
      phases: [{ name: "scan", status: "done", startedAt: 1, endedAt: 5 }],
      agents: [
        {
          id: 0,
          agent: "scout",
          label: "a",
          phase: "scan",
          phaseIndex: 0,
          status: "failed",
          reason: "timeout",
          error: "took too long",
          startedAt: 1,
          endedAt: 4,
          attempts: 2,
          cost: 0.1,
          isolated: true,
        },
      ],
      spawned: 1,
      logs: ["hello"],
      cost: 0.1,
      error: undefined,
      startedAt: 1,
      endedAt: undefined,
    });
    expect(subagentDetails({ details })).toBeUndefined();
  });

  it("only accepts the ultraspawn mode", () => {
    expect(ultraspawnDetails(undefined)).toBeUndefined();
    expect(ultraspawnDetails({ details: "x" })).toBeUndefined();
    expect(ultraspawnDetails({ details: { mode: "parallel", results: [] } })).toBeUndefined();
  });

  it("tolerates malformed fields", () => {
    const parsed = ultraspawnDetails({
      details: {
        mode: "ultraspawn",
        status: "weird",
        phases: [null, { status: 3 }],
        agents: "nope",
        logs: ["ok", 1, null],
        results: [{ usage: { cost: "1" } }],
      },
    });
    expect(parsed).toMatchObject({
      name: "inline",
      status: "running",
      phases: [{ name: "phase", status: "done" }],
      agents: [],
      spawned: 0,
      logs: ["ok"],
      cost: 0,
    });
    expect(
      ultraspawnDetails({ details: { mode: "ultraspawn", agents: [{ status: "x" }, 5] } })?.agents,
    ).toEqual([
      expect.objectContaining({ id: 0, agent: "agent", status: "queued", attempts: 0, cost: 0 }),
    ]);
  });
});
