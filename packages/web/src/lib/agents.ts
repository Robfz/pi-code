import type { AgentInfo } from "@pi-code/protocol";

/** The pi process runs (exited agents aren't live). */
export function isLive(agent: AgentInfo): boolean {
  return agent.status !== "exited";
}
