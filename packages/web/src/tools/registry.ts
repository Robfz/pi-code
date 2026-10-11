/**
 * Tool renderer registry, keyed by `toolName` (`docs/design/03-web-client.md`, "Tool renderers").
 *
 * Renderers register here (`registerToolRenderer("bash", bashRenderer)`) from their own module,
 * imported once by `tools/index.ts`; the conversation screen only calls `getToolRenderer`.
 * Tools without a renderer fall back to the generic one.
 */

import type { LucideIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { splitPath } from "@/lib/paths";

export type ToolStatus =
  /** Assistant is still streaming the call's arguments. */
  | "streaming"
  /** Arguments complete, waiting for / running execution. */
  | "running"
  | "done"
  | "error";

/** `{ content, details }` of a tool result (committed `toolResult` or `tool_execution_end`). */
export interface ToolResultPayload {
  content: unknown[];
  details?: unknown;
}

export interface ToolRendererProps {
  toolCallId: string;
  toolName: string;
  /** Parsed arguments (partial while streaming). */
  args: unknown;
  /** Raw argument JSON while streaming (may be incomplete). */
  argsText?: string;
  status: ToolStatus;
  /** Latest `tool_execution_update.partialResult` while running. */
  partialResult?: unknown;
  result?: ToolResultPayload;
  isError: boolean;
  expanded: boolean;
  /** Proxied curator URL from a `curator` event, if any. */
  curatorUrl?: string;
  /** Execution time: the committed result's, else the live run's. */
  durationMs?: number;
  /** When execution started (the live run's, server clock). */
  startedAt?: number;
}

/** What a tool row shows (`docs/design/09-ui-overhaul.md`, "Tool rows"). */
export interface ToolLabel {
  icon: LucideIcon;
  /** Present tense while running or streaming, past tense when done, "… failed" on error. */
  verb: string;
  target?: { kind: "path" | "code" | "text"; text: string };
  meta?: ReactNode;
}

export interface ToolRenderer {
  label(props: ToolRendererProps): ToolLabel;
  /** Body shown when expanded. */
  Body: ComponentType<ToolRendererProps>;
  /** Expanded while running (Balanced): `bash` and the fallback renderer only. */
  expandWhileRunning?: boolean;
}

type Matcher = (toolName: string) => boolean;

const byName = new Map<string, ToolRenderer>();
const byMatcher: { match: Matcher; renderer: ToolRenderer }[] = [];
let fallback: ToolRenderer | undefined;

/** Register a renderer for a tool name, or for every tool a predicate matches (MCP namespaces). */
export function registerToolRenderer(name: string | Matcher, renderer: ToolRenderer): void {
  if (typeof name === "string") byName.set(name, renderer);
  else byMatcher.push({ match: name, renderer });
}

/** The renderer for tools nobody registered for. */
export function setFallbackToolRenderer(renderer: ToolRenderer): void {
  fallback = renderer;
}

export function getToolRenderer(toolName: string): ToolRenderer {
  const exact = byName.get(toolName);
  if (exact) return exact;
  const matched = byMatcher.find((m) => m.match(toolName));
  if (matched) return matched.renderer;
  if (!fallback) throw new Error("no fallback tool renderer registered (import @/tools)");
  return fallback;
}

/** A call as `runningPhrase` reads it. */
export interface PhraseCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  argsText?: string;
  /** The assistant is still streaming its arguments. */
  streaming?: boolean;
}

/** "Reading foo.ts": a running call's verb and short target (a path's basename, else the text). */
export function runningPhrase(call: PhraseCall): string {
  const { verb, target } = getToolRenderer(call.toolName).label({
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    args: call.args,
    argsText: call.argsText,
    status: call.streaming ? "streaming" : "running",
    isError: false,
    expanded: false,
  });
  const short = target && (target.kind === "path" ? splitPath(target.text).base : target.text);
  return short ? `${verb} ${short}` : verb;
}
