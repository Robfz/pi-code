import type { RpcCommand, RpcResponse } from "./pi-types.ts";

/**
 * pi RPC commands the web client may send through `POST /api/agents/:id/rpc`.
 * Everything else (e.g. `export_html`) is rejected with `400 command_not_allowed`.
 */
export const RPC_COMMAND_ALLOWLIST = [
  // Prompting
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "clear_queue",
  // Models
  "set_model",
  "cycle_model",
  "get_available_models",
  "set_thinking_level",
  "cycle_thinking_level",
  "get_available_thinking_levels",
  // Queue modes
  "set_steering_mode",
  "set_follow_up_mode",
  // Compaction / retry
  "compact",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  // Bash
  "bash",
  "abort_bash",
  // Session
  "new_session",
  "switch_session",
  "fork",
  "clone",
  "get_fork_messages",
  "set_session_name",
  // Queries
  "get_state",
  "get_messages",
  "get_entries",
  "get_tree",
  "get_session_stats",
  "get_last_assistant_text",
  "get_commands",
] as const satisfies readonly RpcCommand["type"][];

export type AllowedRpcCommandType = (typeof RPC_COMMAND_ALLOWLIST)[number];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An allowlisted pi command. */
export type AllowedRpcCommand = Extract<RpcCommand, { type: AllowedRpcCommandType }>;

/** Body of `POST /api/agents/:id/rpc`: an allowlisted pi command without `id`. */
export type RpcCommandBody = DistributiveOmit<AllowedRpcCommand, "id">;

/** pi's response `data` for a command type (`undefined` for commands that return none). */
export type RpcResponseData<T extends RpcCommand["type"]> =
  Extract<RpcResponse, { command: T; success: true }> extends infer R
    ? R extends { data: infer D }
      ? D
      : undefined
    : never;

/**
 * Response body of `POST /api/agents/:id/rpc` for a command type.
 * `bash` answers `202 { data: { id } }` right away; output follows as SSE events.
 */
export type RpcCommandResult<T extends AllowedRpcCommandType> = {
  data: T extends "bash" ? { id: string } : RpcResponseData<T>;
};

const allowlist: ReadonlySet<string> = new Set(RPC_COMMAND_ALLOWLIST);

/** Whether a command type is on the allowlist. */
export function isAllowedRpcCommandType(type: unknown): type is AllowedRpcCommandType {
  return typeof type === "string" && allowlist.has(type);
}
