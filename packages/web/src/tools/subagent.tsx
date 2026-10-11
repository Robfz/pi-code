/**
 * `spawn` tool (pi-extensions subagent extension): a progress widget from `SubagentDetails` in the
 * latest `partialResult` / final result — single, parallel or chain; one card per agent with
 * agent, task, status, duration, usage, nested tool calls and markdown output.
 */

import { BotIcon, CheckIcon, CircleAlertIcon, LoaderIcon, XIcon } from "lucide-react";
import { CollapsibleRow } from "@/components/collapsible-row";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { toolResultText } from "@/lib/content";
import {
  SPAWN_TOOL_NAME,
  type SubagentDetails,
  type SubagentResult,
  type SubagentUsage,
  subagentDetails,
} from "@/lib/subagent-details";
import { formatDuration, formatTokens } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  asRecord,
  isActive,
  Muted,
  Notice,
  plural,
  type Rec,
  statusVerb,
  str,
  truncate,
} from "./common";
import {
  getToolRenderer,
  registerToolRenderer,
  type ToolLabel,
  type ToolRenderer,
  type ToolRendererProps,
  type ToolResultPayload,
  type ToolStatus,
} from "./registry";
import { errorLine, ToolRow } from "./tool-row";

export type AgentStatus = "running" | "done" | "failed";

/**
 * A card's status. Parallel placeholders have `exitCode: -1`; a single / chain step that is
 * still running has no `durationMs` yet (set when its process exits).
 */
export function agentStatus(result: SubagentResult, callActive: boolean): AgentStatus {
  if (result.exitCode === -1) return callActive ? "running" : "failed";
  if (callActive && result.durationMs === undefined) return "running";
  if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
    return "failed";
  }
  return "done";
}

/** "2 turns ↑3.9k ↓218 $0.0051 ctx:2.1k" (the extension's TUI usage line, minus duration/model). */
export function formatUsage(usage: Partial<SubagentUsage> | undefined): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  return parts.join(" ");
}

type Part = { type?: string; text?: string; id?: string; name?: string; arguments?: unknown };

function assistantParts(messages: unknown[]): Part[] {
  const parts: Part[] = [];
  for (const message of messages) {
    const m = asRecord(message);
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      const p = asRecord(part);
      if (p) parts.push(p as Part);
    }
  }
  return parts;
}

/** Last assistant text (the agent's answer so far). */
export function finalOutput(messages: unknown[]): string {
  const texts = assistantParts(messages).filter((p) => p.type === "text" && p.text);
  return texts.at(-1)?.text ?? "";
}

export interface NestedToolCall {
  id: string;
  name: string;
  args: unknown;
  /** From the agent's `toolResult` message, once it has one. */
  result?: ToolResultPayload;
  isError: boolean;
}

/** The agent's tool calls, each with its result when the agent's messages hold it. */
export function nestedToolCalls(messages: unknown[]): NestedToolCall[] {
  const results = new Map<string, Rec>();
  for (const message of messages) {
    const m = asRecord(message);
    const id = str(m, "toolCallId");
    if (m?.role === "toolResult" && id) results.set(id, m);
  }
  return assistantParts(messages)
    .filter((p) => p.type === "toolCall" && typeof p.name === "string")
    .map((p) => {
      const id = p.id ?? "";
      const result = results.get(id);
      return {
        id,
        name: p.name as string,
        args: p.arguments,
        result: result && {
          content: Array.isArray(result.content) ? result.content : [],
          details: result.details,
        },
        isError: result?.isError === true,
      };
    });
}

/** A nested call as a body-less row, labelled by its tool's renderer. */
function NestedToolRow({ call, agentRunning }: { call: NestedToolCall; agentRunning: boolean }) {
  let status: ToolStatus = agentRunning ? "running" : "done";
  if (call.result) status = call.isError ? "error" : "done";
  const props: ToolRendererProps = {
    toolCallId: call.id,
    toolName: call.name,
    args: call.args,
    status,
    result: call.result,
    isError: call.isError,
    expanded: false,
  };
  return (
    <ToolRow
      data-testid="nested-tool-call"
      data-tool={call.name}
      data-status={status}
      label={getToolRenderer(call.name).label(props)}
      status={status}
      error={status === "error" ? errorLine(call.result) : undefined}
    />
  );
}

function StatusIcon({ status }: { status: AgentStatus }) {
  if (status === "running") {
    return (
      <LoaderIcon aria-label="Running" className="size-3.5 animate-spin text-muted-foreground" />
    );
  }
  if (status === "failed")
    return <XIcon aria-label="Failed" className="size-3.5 text-destructive" />;
  return <CheckIcon aria-label="Done" className="size-3.5 text-status-done" />;
}

function AgentCard({
  result,
  status,
  mode,
}: {
  result: SubagentResult;
  status: AgentStatus;
  mode: SubagentDetails["mode"];
}) {
  const tools = nestedToolCalls(result.messages);
  const output = finalOutput(result.messages);
  const usage = formatUsage(result.usage);
  const failure =
    status === "failed" ? result.errorMessage || (!output ? result.stderr : undefined) : undefined;
  return (
    <div
      data-testid="subagent-card"
      data-status={status}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md border bg-background/50 p-2",
        status === "failed" && "border-destructive/50",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <StatusIcon status={status} />
        {mode === "chain" && result.step !== undefined && <Muted>Step {result.step}</Muted>}
        <span className="font-medium">{result.agent}</span>
        {result.agentSource && result.agentSource !== "unknown" && (
          <Badge variant="outline">{result.agentSource}</Badge>
        )}
        {status === "failed" && result.stopReason && (
          <Badge variant="destructive">{result.stopReason}</Badge>
        )}
        <span className="flex-1" />
        {result.durationMs !== undefined && (
          <Muted className="tabular-nums">{formatDuration(result.durationMs)}</Muted>
        )}
      </div>
      {result.task && (
        <CollapsibleRow
          label={
            <span className="truncate text-xs text-muted-foreground">
              {truncate(result.task.replace(/\{previous\}/g, "").trim(), 120)}
            </span>
          }
        >
          <p className="pb-1 text-xs whitespace-pre-wrap break-words text-muted-foreground">
            {result.task}
          </p>
        </CollapsibleRow>
      )}
      {tools.length > 0 && (
        <div data-testid="subagent-tools" className="flex flex-col">
          {tools.map((tool, i) => (
            <NestedToolRow
              // biome-ignore lint/suspicious/noArrayIndexKey: calls in order; ids may be missing
              key={i}
              call={tool}
              agentRunning={status === "running"}
            />
          ))}
        </div>
      )}
      {failure && (
        <p className="flex items-start gap-1 text-xs text-destructive">
          <CircleAlertIcon className="mt-0.5 size-3 shrink-0" />
          <span className="whitespace-pre-wrap break-words">{failure.trim()}</span>
        </p>
      )}
      {output ? (
        <Markdown text={output.trim()} streaming={status === "running"} className="text-xs" />
      ) : (
        status === "running" && tools.length === 0 && <Notice>Running…</Notice>
      )}
      {(usage || result.model) && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {[usage, result.model].filter(Boolean).join(" · ")}
        </p>
      )}
    </div>
  );
}

function aggregateUsage(results: SubagentResult[]): Partial<SubagentUsage> {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  for (const r of results) {
    total.input += r.usage?.input ?? 0;
    total.output += r.usage?.output ?? 0;
    total.cacheRead += r.usage?.cacheRead ?? 0;
    total.cacheWrite += r.usage?.cacheWrite ?? 0;
    total.cost += r.usage?.cost ?? 0;
    total.turns += r.usage?.turns ?? 0;
  }
  return total;
}

/** Details from the final result, else from the latest partial result. */
function currentDetails(props: ToolRendererProps): SubagentDetails | undefined {
  return subagentDetails(props.result) ?? subagentDetails(props.partialResult);
}

interface ArgTask {
  agent: string;
  task: string;
}

function argTasks(args: unknown): { mode: SubagentDetails["mode"]; tasks: ArgTask[] } {
  const rec = asRecord(args);
  const list = (key: string) =>
    Array.isArray(rec?.[key])
      ? (rec[key] as unknown[]).map((t) => ({
          agent: str(t, "agent") ?? "agent",
          task: str(t, "task") ?? "",
        }))
      : [];
  const chain = list("chain");
  if (chain.length > 0) return { mode: "chain", tasks: chain };
  const tasks = list("tasks");
  if (tasks.length > 0) return { mode: "parallel", tasks };
  const agent = str(args, "agent");
  return { mode: "single", tasks: agent ? [{ agent, task: str(args, "task") ?? "" }] : [] };
}

function progressLabel(details: SubagentDetails, active: boolean): string {
  const statuses = details.results.map((r) => agentStatus(r, active));
  const done = statuses.filter((s) => s !== "running").length;
  const failed = statuses.filter((s) => s === "failed").length;
  const running = statuses.length - done;
  const total = details.results.length;
  if (details.mode === "parallel") {
    return running > 0
      ? `${done}/${total} done, ${running} running`
      : `${total - failed}/${total} succeeded`;
  }
  if (details.mode === "chain") {
    return running > 0 ? `step ${done + 1} running` : `${total - failed}/${total} steps`;
  }
  return statuses[0] ?? (active ? "running" : "done");
}

function subagentLabel(props: ToolRendererProps): ToolLabel {
  const details = currentDetails(props);
  const results = details?.results ?? [];
  const count = results.length > 0 ? results.length : argTasks(props.args).tasks.length;
  const progress =
    details && results.length > 0 && details.mode !== "single"
      ? progressLabel(details, isActive(props.status))
      : undefined;
  return {
    icon: BotIcon,
    verb: statusVerb(props.status, "Running", "Ran", "Agents failed"),
    target: count > 0 ? { kind: "text", text: plural(count, "agent", "agents") } : undefined,
    meta: progress && `· ${progress}`,
  };
}

function SubagentBody(props: ToolRendererProps) {
  const details = currentDetails(props);
  const active = isActive(props.status);
  const text = toolResultText(props.result ?? props.partialResult);

  if (!details || details.results.length === 0) {
    const { tasks } = argTasks(props.args);
    return (
      <div className="flex flex-col gap-2">
        {tasks.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: tasks in argument order
          <p key={i} className="text-xs">
            <span className="font-medium">{t.agent}</span> <Muted>{truncate(t.task, 120)}</Muted>
          </p>
        ))}
        {props.result !== undefined ? (
          <p className={cn("whitespace-pre-wrap text-xs", props.isError && "text-destructive")}>
            {text || "(no output)"}
          </p>
        ) : (
          active && <Notice>Starting…</Notice>
        )}
      </div>
    );
  }

  const usage = formatUsage(aggregateUsage(details.results));
  return (
    <div data-testid="subagent-widget" className="flex flex-col gap-2">
      {details.mode !== "single" && (
        <p className="text-xs text-muted-foreground">
          {details.mode} · {progressLabel(details, active)}
        </p>
      )}
      {details.results.map((result, i) => (
        <AgentCard
          // biome-ignore lint/suspicious/noArrayIndexKey: results keep their task position
          key={i}
          result={result}
          status={agentStatus(result, active)}
          mode={details.mode}
        />
      ))}
      {details.mode !== "single" && usage && !active && (
        <p className="text-xs text-muted-foreground tabular-nums">Total: {usage}</p>
      )}
      {props.isError && props.result !== undefined && text && (
        <p className="whitespace-pre-wrap text-xs text-destructive">{text}</p>
      )}
    </div>
  );
}

export const subagentRenderer: ToolRenderer = { label: subagentLabel, Body: SubagentBody };

registerToolRenderer(SPAWN_TOOL_NAME, subagentRenderer);
