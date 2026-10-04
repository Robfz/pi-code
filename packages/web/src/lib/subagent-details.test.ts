import { describe, expect, it } from "vitest";
import { subagentCost } from "./subagent-details";

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
