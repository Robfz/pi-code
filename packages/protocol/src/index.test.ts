import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AgentMessage,
  type AllowedRpcCommandType,
  API_ERROR_STATUS,
  type ApiErrorCode,
  type BashResult,
  isAllowedRpcCommandType,
  isApiError,
  RPC_COMMAND_ALLOWLIST,
  type RpcCommand,
  type RpcCommandBody,
  type RpcCommandResult,
  type RpcResponseData,
  type ServerEventType,
  type SessionEntry,
} from "./index.ts";

describe("protocol", () => {
  it("re-exports pi types", () => {
    expectTypeOf<RpcCommand["type"]>().toExtend<string>();
    expectTypeOf<SessionEntry["type"]>().toExtend<string>();
    expectTypeOf<Extract<AgentMessage, { role: "bashExecution" }>>().not.toBeNever();
    expectTypeOf<BashResult>().toHaveProperty("exitCode");
  });
});

describe("RPC allowlist", () => {
  it("is a subset of pi's command types", () => {
    expectTypeOf<AllowedRpcCommandType>().toExtend<RpcCommand["type"]>();
    expectTypeOf<(typeof RPC_COMMAND_ALLOWLIST)[number]>().toEqualTypeOf<AllowedRpcCommandType>();
  });

  it("matches the contract", () => {
    expect(RPC_COMMAND_ALLOWLIST).toHaveLength(32);
    expect(new Set(RPC_COMMAND_ALLOWLIST).size).toBe(RPC_COMMAND_ALLOWLIST.length);
    expect(isAllowedRpcCommandType("prompt")).toBe(true);
    expect(isAllowedRpcCommandType("get_commands")).toBe(true);
    expect(isAllowedRpcCommandType("export_html")).toBe(false);
    expect(isAllowedRpcCommandType(42)).toBe(false);
    expectTypeOf<"export_html">().not.toExtend<AllowedRpcCommandType>();
  });

  it("types command bodies and results", () => {
    expectTypeOf<RpcCommandBody>().not.toHaveProperty("id");
    expectTypeOf<{
      type: "prompt";
      message: string;
      streamingBehavior: "steer";
    }>().toExtend<RpcCommandBody>();
    expectTypeOf<{ type: "export_html" }>().not.toExtend<RpcCommandBody>();
    expectTypeOf<RpcResponseData<"abort">>().toEqualTypeOf<undefined>();
    expectTypeOf<RpcResponseData<"get_entries">>().toHaveProperty("leafId");
    expectTypeOf<RpcCommandResult<"bash">>().toEqualTypeOf<{ data: { id: string } }>();
  });
});

describe("API errors", () => {
  it("maps every code to its status", () => {
    const codes: ApiErrorCode[] = [
      "invalid_body",
      "outside_home",
      "command_not_allowed",
      "streaming_behavior_required",
      "forbidden_origin",
      "forbidden_host",
      "agent_not_found",
      "session_not_found",
      "not_a_git_repo",
      "dialog_not_found",
      "session_owned",
      "agent_exited",
      "agent_busy",
      "pi_error",
      "pi_timeout",
    ];
    expect(Object.keys(API_ERROR_STATUS).sort()).toEqual([...codes].sort());
    expect(API_ERROR_STATUS.streaming_behavior_required).toBe(400);
    expect(API_ERROR_STATUS.forbidden_origin).toBe(403);
    expect(API_ERROR_STATUS.dialog_not_found).toBe(404);
    expect(API_ERROR_STATUS.session_owned).toBe(409);
    expect(API_ERROR_STATUS.pi_error).toBe(502);
    expect(API_ERROR_STATUS.pi_timeout).toBe(504);
  });

  it("recognizes error bodies", () => {
    expect(isApiError({ error: { code: "agent_busy", message: "x" } })).toBe(true);
    expect(isApiError({ error: { code: "nope", message: "x" } })).toBe(false);
    expect(isApiError({ data: 1 })).toBe(false);
    expect(isApiError(null)).toBe(false);
  });
});

describe("ServerEvent", () => {
  it("has every contract event type", () => {
    expectTypeOf<ServerEventType>().toEqualTypeOf<
      | "pi"
      | "ui_request"
      | "ui_resolved"
      | "entries_appended"
      | "transcript_reset"
      | "state"
      | "stats"
      | "git_status"
      | "curator"
      | "bash_output"
      | "bash_done"
      | "live_reset"
      | "agent_status"
      | "resync"
    >();
  });
});
