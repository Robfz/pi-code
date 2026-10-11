/**
 * Test helpers: tool calls recorded in the pi fixtures (`test/fixtures/*.jsonl`), as the props
 * a renderer receives at each stage (start, every `partialResult`, end).
 */

import { loadFixture } from "@/test/fixtures";
import type { ToolResultPayload } from "./registry";

export interface FixtureToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** Every `tool_execution_update.partialResult`, in order. */
  updates: unknown[];
  result?: ToolResultPayload;
  isError: boolean;
}

type Raw = {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: { content?: unknown[]; details?: unknown };
  isError?: boolean;
};

/** Tool calls of a fixture, in start order. */
export function fixtureToolCalls(name: string): FixtureToolCall[] {
  const calls = new Map<string, FixtureToolCall>();
  for (const { dir, line } of loadFixture(name)) {
    if (dir !== "out" || typeof line !== "object" || line === null) continue;
    const raw = line as Raw;
    if (!raw.type?.startsWith("tool_execution_") || !raw.toolCallId) continue;
    let call = calls.get(raw.toolCallId);
    if (!call) {
      call = {
        toolCallId: raw.toolCallId,
        toolName: raw.toolName ?? "",
        args: raw.args,
        updates: [],
        isError: false,
      };
      calls.set(raw.toolCallId, call);
    }
    if (raw.type === "tool_execution_update") call.updates.push(raw.partialResult);
    if (raw.type === "tool_execution_end") {
      call.result = { content: raw.result?.content ?? [], details: raw.result?.details };
      call.isError = raw.isError === true;
    }
  }
  return [...calls.values()];
}

/** The first call of `toolName` in a fixture (throws when absent). */
export function fixtureToolCall(name: string, toolName: string): FixtureToolCall {
  const call = fixtureToolCalls(name).find((c) => c.toolName === toolName);
  if (!call) throw new Error(`no ${toolName} call in fixture ${name}`);
  return call;
}

export type Stage = "start" | { update: number } | "end";

/** Renderer props (minus `expanded`) for a fixture call at a stage of its execution. */
export function propsAt(call: FixtureToolCall, stage: Stage) {
  const base = { toolCallId: call.toolCallId, toolName: call.toolName, args: call.args };
  if (stage === "end") {
    return {
      ...base,
      status: call.isError ? ("error" as const) : ("done" as const),
      result: call.result,
      isError: call.isError,
    };
  }
  return {
    ...base,
    status: "running" as const,
    partialResult: stage === "start" ? undefined : call.updates[stage.update],
    isError: false,
  };
}

/** The edit tool's `details.patch` from the `tool-calls` fixture. */
export function fixtureEditPatch(): string {
  const details = fixtureToolCall("tool-calls", "edit").result?.details;
  const patch = (details as { patch?: unknown } | undefined)?.patch;
  if (typeof patch !== "string") throw new Error("tool-calls fixture: edit has no details.patch");
  return patch;
}

/** What a tool row shows (`ToolRow`): its icon's lucide name, verb, target, meta and tail. */
export function rowParts(row: HTMLElement) {
  const head = row.firstElementChild as HTMLElement;
  const slot = (name: string) => head.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  const svg = slot("row-icon")?.querySelector("svg");
  return {
    icon: [...(svg?.classList ?? [])].find((c) => c.startsWith("lucide-"))?.slice("lucide-".length),
    verb: slot("row-verb")?.textContent ?? undefined,
    shimmer: slot("row-verb")?.classList.contains("shimmer") ?? false,
    target: slot("row-target")?.textContent ?? undefined,
    meta: slot("row-meta")?.textContent ?? undefined,
    tail: slot("row-tail")?.textContent ?? undefined,
  };
}

/** The open body of a tool row. */
export function rowBody(row: HTMLElement): HTMLElement {
  const body = row.querySelector<HTMLElement>('[data-slot="collapsible-content"]');
  if (!body) throw new Error("the row has no open body");
  return body;
}
