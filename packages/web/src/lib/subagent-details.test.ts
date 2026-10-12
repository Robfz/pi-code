import { describe, expect, it } from "vitest";
import { isUltraspawnCall, subagentCost } from "./subagent-details";

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
