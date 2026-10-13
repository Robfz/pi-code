/**
 * `SubagentDetails` / `UltraspawnDetails` from the pi-extensions `spawn` tool, read defensively from a result,
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

export type UltraspawnStatus = "running" | "done" | "failed" | "aborted" | "canceled";
export type UltraspawnAgentStatus = "queued" | "running" | "done" | "failed";

export interface UltraspawnPhase {
  name: string;
  status: "running" | "done";
  startedAt?: number;
  endedAt?: number;
}

/** One `agent()` call of the script. */
export interface UltraspawnAgent {
  id: number;
  agent: string;
  label?: string;
  phase?: string;
  /** Index into `UltraspawnDetails.phases`. */
  phaseIndex?: number;
  status: UltraspawnAgentStatus;
  reason?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  attempts: number;
  cost: number;
  isolated: boolean;
}

/** The fields of the extension's `UltraspawnDetails` the UI shows. */
export interface UltraspawnDetails {
  name: string;
  status: UltraspawnStatus;
  phases: UltraspawnPhase[];
  agents: UltraspawnAgent[];
  /** `agent()` calls that started running. */
  spawned: number;
  logs: string[];
  /** `usage.cost` summed over every child process. */
  cost: number;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

/**
 * Whether a `spawn` call runs an ultraspawn script (`script` or `ultraspawn` argument). While
 * the call streams, parsed args may not hold the mode key yet, so the raw JSON is checked too.
 */
export function isUltraspawnCall(args: unknown, argsText?: string): boolean {
  const rec = asRecord(args);
  if (rec && ("script" in rec || "ultraspawn" in rec)) return true;
  if (rec && ("agent" in rec || "tasks" in rec || "chain" in rec)) return false;
  return /"(?:script|ultraspawn)"\s*:/.test(argsText ?? "");
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

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((a) => a === value);
}

function records(value: unknown): Rec[] {
  return Array.isArray(value) ? value.map(asRecord).filter((r): r is Rec => r !== undefined) : [];
}

export function ultraspawnDetails(value: unknown): UltraspawnDetails | undefined {
  const details = asRecord(asRecord(value)?.details);
  if (details?.mode !== "ultraspawn") return undefined;
  const phases = records(details.phases).map(
    (p): UltraspawnPhase => ({
      name: str(p, "name") ?? "phase",
      status: oneOf(p.status, ["running", "done"] as const) ?? "done",
      startedAt: num(p, "startedAt"),
      endedAt: num(p, "endedAt"),
    }),
  );
  const agents = records(details.agents).map(
    (a, i): UltraspawnAgent => ({
      id: num(a, "id") ?? i,
      agent: str(a, "agent") ?? "agent",
      label: str(a, "label"),
      phase: str(a, "phase"),
      phaseIndex: num(a, "phaseIndex"),
      status: oneOf(a.status, ["queued", "running", "done", "failed"] as const) ?? "queued",
      reason: str(a, "reason"),
      error: str(a, "error"),
      startedAt: num(a, "startedAt"),
      endedAt: num(a, "endedAt"),
      attempts: num(a, "attempts") ?? 0,
      cost: num(a, "cost") ?? 0,
      isolated: a.isolated === true,
    }),
  );
  return {
    name: str(details, "name") ?? "inline",
    status:
      oneOf(details.status, ["running", "done", "failed", "aborted", "canceled"] as const) ??
      "running",
    phases,
    agents,
    spawned: num(details, "spawned") ?? agents.filter((a) => a.status !== "queued").length,
    logs: Array.isArray(details.logs)
      ? details.logs.filter((l): l is string => typeof l === "string")
      : [],
    cost: subagentCost(value),
    error: str(details, "error"),
    startedAt: num(details, "startedAt"),
    endedAt: num(details, "endedAt"),
  };
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
