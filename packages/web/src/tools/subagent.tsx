/**
 * `spawn` tool (pi-extensions subagent extension): a progress widget from `SubagentDetails` in the
 * latest `partialResult` / final result — single, parallel or chain; one card per agent with
 * agent, task, status, duration, usage, nested tool calls and markdown output. Ultraspawn runs
 * show the script's phases, `agent()` calls and logs instead, like the extension's TUI.
 */

import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  LoaderIcon,
  XIcon,
} from "lucide-react";
import { CollapsibleRow } from "@/components/collapsible-row";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { toolResultText } from "@/lib/content";
import {
  isUltraspawnCall,
  SPAWN_TOOL_NAME,
  type SubagentDetails,
  type SubagentResult,
  type SubagentUsage,
  subagentDetails,
  type UltraspawnAgent,
  type UltraspawnAgentStatus,
  type UltraspawnDetails,
  ultraspawnDetails,
} from "@/lib/subagent-details";
import { formatDuration, formatSeconds, formatTokens } from "@/lib/time";
import { useElapsed } from "@/lib/use-elapsed";
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

export type SubagentStatus = "running" | "done" | "failed";

/**
 * A card's status. Parallel placeholders have `exitCode: -1`; a single / chain step that is
 * still running has no `durationMs` yet (set when its process exits).
 */
export function subagentStatus(result: SubagentResult, callActive: boolean): SubagentStatus {
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

function StatusIcon({ status }: { status: SubagentStatus | UltraspawnAgentStatus }) {
  if (status === "queued") {
    return <CircleDashedIcon aria-label="Queued" className="size-3.5 text-muted-foreground" />;
  }
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
  status: SubagentStatus;
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

function currentUltraspawn(props: ToolRendererProps): UltraspawnDetails | undefined {
  return ultraspawnDetails(props.result) ?? ultraspawnDetails(props.partialResult);
}

function agentCounts(agents: UltraspawnAgent[]) {
  const count = (status: UltraspawnAgentStatus) => agents.filter((a) => a.status === status).length;
  return {
    done: count("done"),
    failed: count("failed"),
    running: count("running"),
    queued: count("queued"),
  };
}

const formatCost = (cost: number) => `$${cost.toFixed(4)}`;

/** "3/5 done · 1 failed · $0.0123" */
function ultraspawnProgress(details: UltraspawnDetails): string | undefined {
  const { done, failed } = agentCounts(details.agents);
  const parts: string[] = [];
  if (details.agents.length > 0) parts.push(`${done}/${details.agents.length} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (details.cost > 0) parts.push(formatCost(details.cost));
  return parts.length > 0 ? parts.join(" · ") : undefined;
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
  const statuses = details.results.map((r) => subagentStatus(r, active));
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
  const verb = statusVerb(props.status, "Running", "Ran", "Agents failed");
  const ultraspawn = currentUltraspawn(props);
  if (ultraspawn) {
    const count = ultraspawn.agents.length;
    const progress = ultraspawnProgress(ultraspawn);
    return {
      icon: BotIcon,
      verb,
      target: count > 0 ? { kind: "text", text: plural(count, "agent", "agents") } : undefined,
      meta: progress && `· ${progress}`,
      tone: "ultraspawn",
    };
  }
  const details = currentDetails(props);
  const results = details?.results ?? [];
  const count = results.length > 0 ? results.length : argTasks(props.args).tasks.length;
  const progress =
    details && results.length > 0 && details.mode !== "single"
      ? progressLabel(details, isActive(props.status))
      : undefined;
  return {
    icon: BotIcon,
    verb,
    target: count > 0 ? { kind: "text", text: plural(count, "agent", "agents") } : undefined,
    meta: progress && `· ${progress}`,
    tone: isUltraspawnCall(props.args, props.argsText) ? "ultraspawn" : undefined,
  };
}

/** Agent rows shown before the rest collapse under "N more agents". */
const VISIBLE_AGENTS = 8;
const VISIBLE_LOGS = 5;
/** Failed agents rank right after running ones so their reasons stay in the visible slice. */
const AGENT_STATUS_RANK: Record<UltraspawnAgent["status"], number> = {
  running: 0,
  failed: 1,
  done: 2,
  queued: 2,
};

function UltraspawnAgentItem({ agent, live }: { agent: UltraspawnAgent; live: boolean }) {
  const elapsed = useElapsed(live && agent.status === "running" ? agent.startedAt : undefined);
  const duration =
    agent.startedAt !== undefined && agent.endedAt !== undefined
      ? formatDuration(agent.endedAt - agent.startedAt)
      : elapsed !== undefined
        ? formatSeconds(elapsed)
        : undefined;
  const failure =
    agent.status === "failed"
      ? [agent.reason, agent.error?.split("\n")[0]].filter(Boolean).join(": ")
      : "";
  return (
    <li data-testid="ultraspawn-agent" data-status={agent.status} className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-1.5">
        <StatusIcon status={agent.status} />
        <span className="shrink-0 font-medium">{agent.agent}</span>
        {agent.label && <Muted className="min-w-0 truncate">{agent.label}</Muted>}
        {agent.phase && <Badge variant="outline">{agent.phase}</Badge>}
        {agent.isolated && <Badge variant="outline">isolated</Badge>}
        {agent.attempts > 1 && <Badge variant="secondary">{agent.attempts}×</Badge>}
        <span className="flex-1" />
        {agent.cost > 0 && <Muted className="tabular-nums">{formatCost(agent.cost)}</Muted>}
        {duration && <Muted className="tabular-nums">{duration}</Muted>}
      </div>
      {failure && (
        <p className="flex items-start gap-1 pl-5 text-destructive">
          <CircleAlertIcon className="mt-0.5 size-3 shrink-0" />
          <span className="break-words">{truncate(failure, 200)}</span>
        </p>
      )}
    </li>
  );
}

function UltraspawnBody({
  details,
  result,
  isError,
  status,
}: { details: UltraspawnDetails } & ToolRendererProps) {
  const live = isActive(status) && details.status === "running";
  const elapsed = useElapsed(live ? details.startedAt : undefined);
  // Details persisted from an interrupted run can hold phases and agents still marked running.
  const allAgents = live
    ? details.agents
    : details.agents.map((a) =>
        a.status === "running" ? { ...a, status: "failed" as const, reason: "interrupted" } : a,
      );
  const counts = agentCounts(allAgents);
  // A canceled run was refused at approval and never spawned anything.
  const header = (
    details.status === "canceled"
      ? [details.status]
      : [
          details.status,
          `${counts.done} done`,
          `${counts.failed} failed`,
          `${counts.running} running`,
          counts.queued > 0 && `${counts.queued} queued`,
          `${details.spawned} spawned`,
          formatCost(details.cost),
          details.startedAt !== undefined && details.endedAt !== undefined
            ? formatDuration(details.endedAt - details.startedAt)
            : elapsed !== undefined && formatSeconds(elapsed),
        ]
  )
    .filter(Boolean)
    .join(" · ");
  const agents = allAgents.toSorted(
    (a, b) => AGENT_STATUS_RANK[a.status] - AGENT_STATUS_RANK[b.status],
  );
  const hiddenAgents = agents.slice(VISIBLE_AGENTS);
  const earlierLogs = details.logs.slice(0, -VISIBLE_LOGS);
  const recentLogs = details.logs.slice(-VISIBLE_LOGS);
  const text = toolResultText(result);

  return (
    <div data-testid="ultraspawn-widget" className="flex flex-col gap-2 text-xs">
      <p data-testid="ultraspawn-header" className="text-muted-foreground tabular-nums">
        <span className="font-medium text-foreground">{details.name}</span> · {header}
      </p>
      {details.error && details.status !== "done" && result === undefined && (
        <p className="whitespace-pre-wrap break-words text-destructive">{details.error}</p>
      )}
      {details.phases.length > 0 && (
        <ul data-testid="ultraspawn-phases" className="flex flex-col gap-0.5">
          {details.phases.map((phase, i) => {
            const inPhase = allAgents.filter((a) => a.phaseIndex === i);
            const failed = inPhase.filter((a) => a.status === "failed").length;
            const finished = inPhase.filter((a) => a.status === "done").length + failed;
            const running = phase.status === "running" && live;
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: phases only append; names can repeat
                key={i}
                data-testid="ultraspawn-phase"
                className="flex min-w-0 items-center gap-1.5"
              >
                <StatusIcon status={running ? "running" : "done"} />
                <span className="truncate font-medium">{phase.name}</span>
                <Muted className="tabular-nums">
                  {finished}/{inPhase.length}
                </Muted>
                {failed > 0 && <span className="text-destructive">{failed} failed</span>}
                <span className="flex-1" />
                {phase.startedAt !== undefined && phase.endedAt !== undefined && (
                  <Muted className="tabular-nums">
                    {formatDuration(phase.endedAt - phase.startedAt)}
                  </Muted>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {agents.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <ul data-testid="ultraspawn-agents" className="flex flex-col gap-0.5">
            {agents.slice(0, VISIBLE_AGENTS).map((agent) => (
              <UltraspawnAgentItem key={agent.id} agent={agent} live={live} />
            ))}
          </ul>
          {hiddenAgents.length > 0 && (
            <CollapsibleRow
              label={<Muted>{plural(hiddenAgents.length, "more agent", "more agents")}</Muted>}
            >
              <ul className="flex flex-col gap-0.5">
                {hiddenAgents.map((agent) => (
                  <UltraspawnAgentItem key={agent.id} agent={agent} live={live} />
                ))}
              </ul>
            </CollapsibleRow>
          )}
        </div>
      )}
      {details.logs.length > 0 && (
        <div
          data-testid="ultraspawn-logs"
          className="-mx-2 flex max-h-60 flex-col overflow-auto px-2 text-muted-foreground"
        >
          {earlierLogs.length > 0 && (
            <CollapsibleRow
              label={
                <Muted>{plural(earlierLogs.length, "earlier log line", "earlier log lines")}</Muted>
              }
            >
              {earlierLogs.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: log lines only append
                <p key={i} className="whitespace-pre-wrap break-words font-mono">
                  {line}
                </p>
              ))}
            </CollapsibleRow>
          )}
          {recentLogs.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: log lines only append
            <p key={earlierLogs.length + i} className="whitespace-pre-wrap break-words font-mono">
              {line}
            </p>
          ))}
        </div>
      )}
      {result !== undefined && (
        <p className={cn("whitespace-pre-wrap", isError && "text-destructive")}>
          {text || "(no output)"}
        </p>
      )}
    </div>
  );
}

function SubagentBody(props: ToolRendererProps) {
  const ultraspawn = currentUltraspawn(props);
  if (ultraspawn) return <UltraspawnBody {...props} details={ultraspawn} />;
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
          status={subagentStatus(result, active)}
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
