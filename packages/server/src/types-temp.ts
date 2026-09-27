/**
 * TEMPORARY local types — replace with imports from `@pi-code/protocol` once its types land.
 *
 * Minimal structural subsets of pi's RPC types (`@earendil-works/pi-coding-agent`) and of the
 * API contract's shared types (docs/design/02-api-contract.md). Kept loose on purpose: the server
 * forwards pi records verbatim and only reads the fields listed here.
 */

/** A pi RPC command (`RpcCommand`), without the correlation id. */
export interface PiCommand {
  type: string;
  [key: string]: unknown;
}

/** A pi RPC response record (`RpcResponse`). */
export interface PiResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** A pi session event (`JsonAgentSessionEvent`), forwarded verbatim. */
export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

/** A pi extension UI request (`RpcExtensionUIRequest`). */
export interface PiUiRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  [key: string]: unknown;
}

/** A pi extension UI response (`RpcExtensionUIResponse`). */
export type PiUiResponse = { type: "extension_ui_response"; id: string } & (
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }
);

/** Subset of pi's `RpcSessionState` read by the server. */
export interface PiSessionState {
  isStreaming: boolean;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  [key: string]: unknown;
}

export type AgentId = string;
export type Attention = "none" | "finished" | "failed" | "input";
export type AgentStatus = "awaiting_trust" | "starting" | "ready" | "exited";

export interface AgentInfo {
  id: AgentId;
  cwd: string;
  status: AgentStatus;
  trustPrompt?: { cwd: string };
  exitCode?: number;
  stderrTail?: string[];
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  isStreaming: boolean;
  attention: Attention;
  startedAt: string;
}

export type ErrorCode =
  | "invalid_body"
  | "outside_home"
  | "command_not_allowed"
  | "streaming_behavior_required"
  | "forbidden_origin"
  | "forbidden_host"
  | "not_found"
  | "agent_not_found"
  | "session_not_found"
  | "not_a_git_repo"
  | "dialog_not_found"
  | "session_owned"
  | "agent_exited"
  | "agent_busy"
  | "pi_error"
  | "pi_timeout"
  | "internal";

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string };
}
