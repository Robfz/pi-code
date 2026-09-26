import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AgentMessage,
  PROTOCOL_VERSION,
  type RpcCommand,
  type SessionEntry,
} from "./index.ts";

describe("protocol", () => {
  it("exposes a protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("re-exports pi types", () => {
    expectTypeOf<RpcCommand["type"]>().toExtend<string>();
    expectTypeOf<SessionEntry["type"]>().toExtend<string>();
    expectTypeOf<Extract<AgentMessage, { role: "bashExecution" }>>().not.toBeNever();
  });
});
