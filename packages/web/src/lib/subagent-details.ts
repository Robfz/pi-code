/**
 * `SubagentDetails` from the pi-extensions `spawn` tool, read defensively from a result,
 * partial result or committed `toolResult` message (anything with a `details` field).
 */

import { asRecord, num, type Rec, str } from "@/lib/record";

/** Not "subagent": that name belongs to the pi-subagents package, whose details differ. */
export const SPAWN_TOOL_NAME = "spawn";

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens?: number;
  turns?: number;
}

export interface SubagentResult {
  agent: string;
  agentSource?: string;
  task: string;
  exitCode: number;
  messages: unknown[];
  stderr?: string;
  usage?: Partial<SubagentUsage>;
  model?: string;
  durationMs?: number;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope?: string;
  results: SubagentResult[];
}

export function subagentDetails(value: unknown): SubagentDetails | undefined {
  const details = asRecord(asRecord(value)?.details);
  if (!details) return undefined;
  const mode = details.mode;
  if (mode !== "single" && mode !== "parallel" && mode !== "chain") return undefined;
  const results = Array.isArray(details.results)
    ? details.results
        .map(asRecord)
        .filter((r): r is Rec => r !== undefined)
        .map(
          (r): SubagentResult => ({
            agent: str(r, "agent") ?? "agent",
            agentSource: str(r, "agentSource"),
            task: str(r, "task") ?? "",
            exitCode: num(r, "exitCode") ?? 0,
            messages: Array.isArray(r.messages) ? r.messages : [],
            stderr: str(r, "stderr"),
            usage: asRecord(r.usage) as Partial<SubagentUsage> | undefined,
            model: str(r, "model"),
            durationMs: num(r, "durationMs"),
            stopReason: str(r, "stopReason"),
            errorMessage: str(r, "errorMessage"),
            step: num(r, "step"),
          }),
        )
    : [];
  return { mode, agentScope: str(details, "agentScope"), results };
}

/**
 * Cost of a subagent call so far: `usage.cost` summed over `details.results`, whatever the
 * `mode`; 0 without a results array (e.g. `{}` from a thrown call).
 */
export function subagentCost(value: unknown): number {
  const results = asRecord(asRecord(value)?.details)?.results;
  if (!Array.isArray(results)) return 0;
  let cost = 0;
  for (const r of results) cost += num(asRecord(r)?.usage, "cost") ?? 0;
  return cost;
}
