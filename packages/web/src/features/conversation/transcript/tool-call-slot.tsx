import { useConversation } from "@/store/context";
import { selectIsRunning, selectToolResults } from "@/store/selectors";
import type { ToolResultPayload, ToolStatus } from "@/tools/registry";
import { ToolCallView } from "@/tools/tool-call-view";

function asPayload(result: unknown): ToolResultPayload | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const { content, details } = result as { content?: unknown; details?: unknown };
  return { content: Array.isArray(content) ? content : [], details };
}

function parseArgs(text: string): unknown {
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * One tool call, paired with its committed `toolResult` (by `toolCallId`) or, until that is
 * committed, with the live `ToolRun`. Subscribes only to this call's slices.
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
  const running = useConversation(selectIsRunning);

  let status: ToolStatus;
  let result: ToolResultPayload | undefined;
  let isError = false;
  if (committed) {
    isError = committed.isError;
    status = isError ? "error" : "done";
    result = { content: committed.content, details: committed.details };
  } else if (live) {
    status = live.status;
    isError = live.status === "error";
    result = asPayload(live.result);
  } else if (streaming) {
    status = "streaming";
  } else {
    status = running ? "running" : "done";
  }

  const resolvedArgs =
    live?.args ?? args ?? (argsText !== undefined ? parseArgs(argsText) : undefined);

  return (
    <ToolCallView
      toolCallId={toolCallId}
      toolName={live?.toolName ?? toolName}
      args={resolvedArgs}
      argsText={argsText}
      status={status}
      partialResult={committed ? undefined : live?.partialResult}
      result={result}
      isError={isError}
      curatorUrl={curatorUrl}
    />
  );
}
