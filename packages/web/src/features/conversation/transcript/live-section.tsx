import type { StreamingBlock } from "@pi-code/protocol";
import { CircleAlertIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { useMemo } from "react";
import { Markdown } from "@/components/markdown";
import { useConversation } from "@/store/context";
import {
  selectActiveBranch,
  selectBash,
  selectBranchToolCallIds,
  selectPendingUser,
  selectRun,
  selectStreaming,
  selectTools,
} from "@/store/selectors";
import { BashExecutionView, bashFromResult } from "./bash-execution";
import { Thinking } from "./thinking";
import { ToolCallSlot } from "./tool-call-slot";
import { UserMessageView } from "./user-message";

function sortedBlocks(blocks: Record<number, StreamingBlock>): [number, StreamingBlock][] {
  return Object.entries(blocks)
    .map(([index, block]) => [Number(index), block] as [number, StreamingBlock])
    .sort((a, b) => a[0] - b[0]);
}

/** The assistant message in flight. Only this subtree re-renders on token deltas. */
export function StreamingMessage() {
  const streaming = useConversation(selectStreaming);
  if (streaming === undefined) return null;
  const blocks = sortedBlocks(streaming.blocks);
  return (
    <div data-testid="streaming-message" className="flex min-w-0 flex-col gap-2">
      {blocks.map(([index, block]) => {
        switch (block.type) {
          case "text":
            return <Markdown key={index} text={block.text} streaming={!block.done} />;
          case "thinking":
            return <Thinking key={index} text={block.text} live={!block.done} />;
          case "toolCall":
            return (
              <ToolCallSlot
                key={block.id || `pending-${index}`}
                toolCallId={block.id}
                toolName={block.name}
                args={block.call?.arguments}
                argsText={block.argsText}
                streaming={block.call === undefined}
              />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

/** Tools running with no call in the transcript or the streaming message (e.g. after reload). */
function OrphanTools() {
  const tools = useConversation(selectTools);
  const committedIds = useConversation(selectBranchToolCallIds);
  const streamingIds = useConversation((s) =>
    Object.values(s.live.streaming?.blocks ?? {})
      .flatMap((b) => (b.type === "toolCall" ? [b.id] : []))
      .join("\n"),
  );
  const orphans = useMemo(() => {
    const streamingSet = new Set(streamingIds.split("\n"));
    return Object.entries(tools).filter(([id]) => !committedIds.has(id) && !streamingSet.has(id));
  }, [tools, committedIds, streamingIds]);
  return orphans.map(([id, run]) => (
    <ToolCallSlot key={id} toolCallId={id} toolName={run.toolName} args={run.args} />
  ));
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

/** Live, not-yet-committed part of the conversation. */
export function LiveSection() {
  const pendingUser = useConversation(selectPendingUser);
  return (
    <div data-testid="live" className="flex flex-col gap-4 empty:hidden">
      {pendingUser && <UserMessageView message={pendingUser} pending />}
      <StreamingMessage />
      <OrphanTools />
      <BashRuns />
      <RunStatus />
    </div>
  );
}
