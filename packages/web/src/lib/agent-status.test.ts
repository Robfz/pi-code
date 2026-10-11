import { describe, expect, it } from "vitest";
import { makeAgent } from "@/test/fixtures";
import { agentStatus, STATUS_LABEL } from "./agent-status";

describe("agentStatus", () => {
  it("covers every row of the vocabulary", () => {
    expect(agentStatus(makeAgent({ attention: "input" }))).toBe("input");
    expect(agentStatus(makeAgent({ status: "awaiting_trust" }))).toBe("input");
    expect(agentStatus(makeAgent({ status: "starting" }))).toBe("working");
    expect(agentStatus(makeAgent({ isStreaming: true }))).toBe("working");
    expect(agentStatus(makeAgent({ attention: "failed" }))).toBe("failed");
    expect(agentStatus(makeAgent({ attention: "finished" }))).toBe("finished");
    expect(agentStatus(makeAgent({ status: "exited" }))).toBe("closed");
    expect(agentStatus(makeAgent())).toBe("idle");
  });

  it("puts input over working and working over failed", () => {
    expect(agentStatus(makeAgent({ isStreaming: true, attention: "input" }))).toBe("input");
    expect(agentStatus(makeAgent({ status: "awaiting_trust" }), true)).toBe("input");
    expect(agentStatus(makeAgent({ isStreaming: true, attention: "failed" }))).toBe("working");
    expect(agentStatus(makeAgent({ status: "starting", attention: "finished" }))).toBe("working");
  });

  it("keeps Failed on an exited agent", () => {
    expect(agentStatus(makeAgent({ status: "exited", attention: "failed" }))).toBe("failed");
  });

  it("reads a pending resume or restart as Working", () => {
    expect(agentStatus(undefined, true)).toBe("working");
    expect(agentStatus(makeAgent({ status: "exited", attention: "failed" }), true)).toBe("working");
  });

  it("reads a session row as Closed", () => {
    expect(agentStatus(undefined)).toBe("closed");
  });

  it("labels each status with one word", () => {
    expect(STATUS_LABEL).toEqual({
      input: "Needs input",
      working: "Working",
      failed: "Failed",
      finished: "Finished",
      closed: "Closed",
      idle: "Idle",
    });
  });
});
