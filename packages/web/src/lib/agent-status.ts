import type { AgentInfo } from "@pi-code/protocol";

/** The status vocabulary (`docs/design/09-ui-overhaul.md`, "Status vocabulary"). */
export type AgentStatusKind = "input" | "working" | "failed" | "finished" | "closed" | "idle";

export const STATUS_LABEL: Record<AgentStatusKind, string> = {
  input: "Needs input",
  working: "Working",
  failed: "Failed",
  finished: "Finished",
  closed: "Closed",
  idle: "Idle",
};

/**
 * A row's status: `agent` is undefined for a session no agent holds; `pending` is true while
 * the row's resume or restart is in flight. The first match wins.
 */
export function agentStatus(agent: AgentInfo | undefined, pending = false): AgentStatusKind {
  if (agent?.attention === "input" || agent?.status === "awaiting_trust") return "input";
  if (pending || agent?.status === "starting" || agent?.isStreaming) return "working";
  if (agent?.attention === "failed") return "failed";
  if (agent?.attention === "finished") return "finished";
  if (agent === undefined || agent.status === "exited") return "closed";
  return "idle";
}
