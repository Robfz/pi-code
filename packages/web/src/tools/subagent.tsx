/**
 * `subagent` tool (pi-extensions `subagent`): a progress widget from `SubagentDetails` in the
 * latest `partialResult` / final result — single, parallel or chain; one card per agent with
 * agent, task, status, duration, usage, nested tool calls and markdown output.
 */

import { CheckIcon, CircleAlertIcon, LoaderIcon, XIcon } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { toolResultText } from "@/lib/content";
import {
  type SubagentDetails,
  type SubagentResult,
  type SubagentUsage,
  subagentDetails,
} from "@/lib/subagent-details";
import { formatTokens } from "@/lib/time";
import { cn } from "@/lib/utils";
import { argPath, asRecord, isActive, Muted, Notice, str, truncate } from "./common";
import { registerToolRenderer, type ToolRenderer, type ToolRendererProps } from "./registry";

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

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
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

type Part = { type?: string; text?: string; name?: string; arguments?: unknown };

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
  name: string;
  hint: string;
}

/** One-line description of a nested tool call (like the extension's `formatToolCall`). */
function toolCallHint(name: string, args: unknown): string {
  const path = argPath(args);
  switch (name) {
    case "bash":
      return `$ ${truncate(str(args, "command") ?? "…", 60)}`;
    case "read":
    case "write":
    case "edit":
    case "ls":
      return path ?? (name === "ls" ? "." : "…");
    case "grep":
      return `/${str(args, "pattern") ?? ""}/ in ${path ?? "."}`;
    case "find":
      return `${str(args, "pattern") ?? "*"} in ${path ?? "."}`;
    default: {
      const json = JSON.stringify(args ?? {});
      return json.length > 60 ? `${json.slice(0, 59)}…` : json;
    }
  }
}

export function nestedToolCalls(messages: unknown[]): NestedToolCall[] {
  return assistantParts(messages)
    .filter((p) => p.type === "toolCall" && typeof p.name === "string")
    .map((p) => ({ name: p.name as string, hint: toolCallHint(p.name as string, p.arguments) }));
}

function StatusIcon({ status }: { status: AgentStatus }) {
  if (status === "running") {
    return (
      <LoaderIcon aria-label="Running" className="size-3.5 animate-spin text-muted-foreground" />
    );
  }
  if (status === "failed")
    return <XIcon aria-label="Failed" className="size-3.5 text-destructive" />;
  return (
    <CheckIcon aria-label="Done" className="size-3.5 text-emerald-600 dark:text-emerald-400" />
  );
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
        <details className="text-xs">
          <summary className="cursor-pointer truncate text-muted-foreground select-none">
            {truncate(result.task.replace(/\{previous\}/g, "").trim(), 120)}
          </summary>
          <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
            {result.task}
          </p>
        </details>
      )}
      {tools.length > 0 && (
        <ul data-testid="subagent-tools" className="flex flex-col gap-0.5 font-mono text-xs">
          {tools.map((tool, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: calls in order, names may repeat
            <li key={i} className="truncate">
              <Muted>→ </Muted>
              {tool.name} <Muted>{tool.hint}</Muted>
            </li>
          ))}
        </ul>
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
        <p className="text-[11px] text-muted-foreground tabular-nums">
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

function SubagentSummary(props: ToolRendererProps) {
  const details = currentDetails(props);
  const active = isActive(props.status);
  const { mode, tasks } = argTasks(props.args);
  const effectiveMode = details?.mode ?? mode;
  const agents =
    details && details.results.length > 0
      ? [...new Set(details.results.map((r) => r.agent))]
      : [...new Set(tasks.map((t) => t.agent))];
  const label = details && details.results.length > 0 ? progressLabel(details, active) : undefined;
  return (
    <span className="text-muted-foreground">
      <span className="text-foreground">{effectiveMode}</span>
      {agents.length > 0 && ` · ${agents.join(", ")}`}
      {label && ` · ${label}`}
    </span>
  );
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
        <p className="text-[11px] text-muted-foreground tabular-nums">Total: {usage}</p>
      )}
      {props.isError && props.result !== undefined && text && (
        <p className="whitespace-pre-wrap text-xs text-destructive">{text}</p>
      )}
    </div>
  );
}

export const subagentRenderer: ToolRenderer = {
  Summary: SubagentSummary,
  Body: SubagentBody,
  expandWhileRunning: true,
};

registerToolRenderer("subagent", subagentRenderer);
