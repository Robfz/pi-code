import { useMemo } from "react";
import { useConversation } from "@/store/context";
import type { ConversationState } from "@/store/conversation-store";
import { selectToolResults } from "@/store/selectors";
import type { ToolResultPayload, ToolStatus } from "@/tools/registry";
import { ToolCallView } from "@/tools/tool-call-view";

function asPayload(result: unknown): ToolResultPayload | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const { content, details } = result as { content?: unknown; details?: unknown };
  return { content: Array.isArray(content) ? content : [], details };
}

/**
 * A call's status: its committed result's, else its live run's; a call with neither runs while
 * the run is active.
 */
export function toolStatus(
  s: ConversationState,
  toolCallId: string,
  streaming = false,
): ToolStatus {
  const committed = selectToolResults(s).get(toolCallId);
  if (committed) return committed.isError ? "error" : "done";
  const live = s.live.tools[toolCallId];
  if (live) return live.status;
  if (streaming) return "streaming";
  return s.live.run.active ? "running" : "done";
}

/**
 * One tool call, paired with its committed `toolResult` (by `toolCallId`) or, until that is
 * committed, with the live `ToolRun` (and its timing). Subscribes only to this call's slices.
 *
 * While the assistant streams the call, only the raw `argsText` is shown (no re-parsing of
 * partial JSON on every delta); parsed `args` arrive with `toolcall_end` (`block.call`).
 */
export function ToolCallSlot({
  toolCallId,
  toolName,
  args,
  argsText,
  streaming = false,
}: {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  /** Raw arguments while the assistant is still streaming the call. */
  argsText?: string;
  streaming?: boolean;
}) {
  const committed = useConversation((s) => selectToolResults(s).get(toolCallId));
  const live = useConversation((s) => s.live.tools[toolCallId]);
  const curatorUrl = useConversation((s) => s.live.curator[toolCallId]);
  const status = useConversation((s) => toolStatus(s, toolCallId, streaming));
  const liveResult = live?.result;
  const result = useMemo<ToolResultPayload | undefined>(() => {
    if (committed) return { content: committed.content, details: committed.details };
    return asPayload(liveResult);
  }, [committed, liveResult]);

  return (
    <ToolCallView
      toolCallId={toolCallId}
      toolName={live?.toolName ?? toolName}
      args={live?.args ?? args}
      argsText={argsText}
      status={status}
      partialResult={committed ? undefined : live?.partialResult}
      result={result}
      isError={status === "error"}
      curatorUrl={curatorUrl}
      durationMs={committed ? committed.durationMs : live?.durationMs}
      startedAt={committed ? undefined : live?.startedAt}
    />
  );
}
