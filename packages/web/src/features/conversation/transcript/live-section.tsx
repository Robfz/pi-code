import type { StreamingBlock, StreamingMessage, ToolRun } from "@pi-code/protocol";
import { CircleAlertIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { useMemo } from "react";
import { useConversation } from "@/store/context";
import {
  selectActiveBranch,
  selectBash,
  selectBranchToolCallIds,
  selectRun,
} from "@/store/selectors";
import { blockKey, type Step } from "@/store/turns";
import { BashExecutionView, bashFromResult } from "./bash-execution";

function sortedBlocks(blocks: Record<number, StreamingBlock>): [number, StreamingBlock][] {
  return Object.entries(blocks)
    .map(([index, block]) => [Number(index), block] as [number, StreamingBlock])
    .sort((a, b) => a[0] - b[0]);
}

/** The steps of the assistant message in flight. */
function streamingSteps(streaming: StreamingMessage | undefined): Step[] {
  if (streaming === undefined) return [];
  return sortedBlocks(streaming.blocks).flatMap(([index, block]): Step[] => {
    const key = blockKey(streaming.timestamp, index);
    switch (block.type) {
      case "text":
        return block.text.trim() === ""
          ? []
          : [{ kind: "text", key, text: block.text, streaming: !block.done }];
      case "thinking":
        return block.done && block.text.trim() === ""
          ? []
          : [
              {
                kind: "thinking",
                key,
                text: block.text,
                redacted: false,
                live: !block.done,
                startedAt: block.startedAt,
                endedAt: block.endedAt,
              },
            ];
      case "toolCall":
        return [
          {
            kind: "tool",
            key: block.id || `pending-${index}`,
            toolCallId: block.id,
            toolName: block.name,
            args: block.call?.arguments,
            argsText: block.argsText,
            streaming: block.call === undefined,
          },
        ];
      default:
        return [];
    }
  });
}

const NO_TOOLS: Record<string, ToolRun> = {};
const NO_IDS = new Set<string>();
const NO_STEPS: Step[] = [];

/**
 * What the live turn adds to its committed steps: the streaming message's blocks, then tools
 * running with no call in the transcript or the streaming message (e.g. after a reload).
 * `enabled` only for the transcript's last turn; the others subscribe to constants, so token
 * deltas re-render that turn alone.
 */
export function useLiveSteps(enabled: boolean): { active: boolean; steps: Step[] } {
  const active = useConversation(
    (s) =>
      enabled &&
      (s.live.run.active || s.live.streaming !== undefined || s.live.pendingUser !== undefined),
  );
  const streaming = useConversation((s) => (enabled ? s.live.streaming : undefined));
  const tools = useConversation((s) => (enabled ? s.live.tools : NO_TOOLS));
  const committedIds = useConversation((s) => (enabled ? selectBranchToolCallIds(s) : NO_IDS));
  const steps = useMemo(() => {
    const fromStreaming = streamingSteps(streaming);
    const streamingIds = new Set(
      fromStreaming.flatMap((step) => (step.kind === "tool" ? [step.toolCallId] : [])),
    );
    const orphans = Object.entries(tools)
      .filter(([id]) => !committedIds.has(id) && !streamingIds.has(id))
      .map(
        ([id, run]): Step => ({
          kind: "tool",
          key: id,
          toolCallId: id,
          toolName: run.toolName,
          args: run.args,
        }),
      );
    const all = [...fromStreaming, ...orphans];
    return all.length > 0 ? all : NO_STEPS;
  }, [streaming, tools, committedIds]);
  return { active, steps };
}

/** `!` / `!!` commands in flight (committed as `bashExecution` entries when done). */
function BashRuns() {
  const bash = useConversation(selectBash);
  return Object.entries(bash).map(([id, run]) => (
    <BashExecutionView
      key={id}
      bash={{
        ...bashFromResult(run.command, run.output, run.done),
        excludeFromContext: run.excludeFromContext === true,
      }}
      running={run.done === undefined}
    />
  ));
}

function RunStatus() {
  const run = useConversation(selectRun);
  const idle = useConversation(
    (s) =>
      s.live.streaming === undefined &&
      s.live.pendingUser === undefined &&
      !Object.values(s.live.tools).some((t) => t.status === "running"),
  );
  // An assistant error is already shown on its committed message.
  const lastAssistantError = useConversation((s) => {
    const branch = selectActiveBranch(s);
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry?.type === "message" && entry.message.role === "assistant") {
        return entry.message.errorMessage;
      }
    }
    return undefined;
  });
  if (run.compaction) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <LoaderIcon className="size-3.5 animate-spin" /> Compacting context…
      </div>
    );
  }
  if (run.retry) {
    return (
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <RefreshCwIcon className="mt-0.5 size-3.5 animate-spin" />
        <span>
          Retrying ({run.retry.attempt}/{run.retry.maxAttempts}) · {run.retry.errorMessage}
        </span>
      </div>
    );
  }
  if (run.active && idle) {
    return (
      <div data-testid="working" className="flex items-center gap-2 text-xs text-muted-foreground">
        <LoaderIcon className="size-3.5 animate-spin" /> Working…
      </div>
    );
  }
  if (!run.active && run.lastError && run.lastError !== lastAssistantError) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
        <span className="break-words">{run.lastError}</span>
      </div>
    );
  }
  return null;
}

/** After the turns: `!cmd` runs in flight and the run's status. */
export function LiveSection() {
  return (
    <div data-testid="live" className="flex flex-col gap-4 empty:hidden">
      <BashRuns />
      <RunStatus />
    </div>
  );
}
