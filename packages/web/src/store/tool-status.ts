/**
 * Tool call status and live activity: the one place that decides whether a call is running, so
 * the rows (`ToolCallSlot`, `ExplorationGroupRow`) and the live-status row agree on it.
 */

import type { LiveRun, SessionEntry } from "@pi-code/protocol";
import type { ConversationState } from "./conversation-store";
import { memoByIdentity, selectActiveBranch, selectToolResults } from "./selectors";

export type ToolStatus =
  /** Assistant is still streaming the call's arguments. */
  | "streaming"
  /** Arguments complete, waiting for / running execution. */
  | "running"
  | "done"
  | "error";

/** Whether the call is still going (arguments streaming or executing). */
export function isActive(status: ToolStatus): boolean {
  return status === "running" || status === "streaming";
}

/** A call as the live-status row names it ("Reading foo.ts"). */
export interface ActiveCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  argsText?: string;
  /** The assistant is still streaming its arguments. */
  streaming?: boolean;
}

/**
 * The active branch's committed tool calls: those before its last user message (`earlier`) and
 * those after it (`last`, the last turn's).
 */
const branchCallsOf = memoByIdentity((branch: SessionEntry[]) => {
  const earlier = new Set<string>();
  let last: ActiveCall[] = [];
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      for (const call of last) earlier.add(call.toolCallId);
      last = [];
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        last.push({ toolCallId: block.id, toolName: block.name, args: block.arguments });
      }
    }
  }
  return { earlier, last };
});

/**
 * Whether a call is in the live turn: the branch's last turn (with the streaming message), or,
 * once a pending user message starts a new one, only the streaming message.
 */
function inLiveTurn(s: ConversationState, toolCallId: string): boolean {
  const { earlier, last } = branchCallsOf(selectActiveBranch(s));
  if (earlier.has(toolCallId)) return false;
  return s.live.pendingUser === undefined || !last.some((call) => call.toolCallId === toolCallId);
}

/**
 * A call's status: its committed result's, else its live run's, else "streaming" while the
 * assistant streams its arguments. A call with none of these runs while the run is active if
 * it's in the live turn; one in an earlier turn (left unanswered by an aborted message) is done.
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
  return s.live.run.active && inLiveTurn(s, toolCallId) ? "running" : "done";
}

/** The calls whose rows shimmer: live runs, the live turn's calls, the streaming message's. */
function activeCalls(s: ConversationState): ActiveCall[] {
  const { streaming, tools } = s.live;
  const candidates: ActiveCall[] = [
    ...Object.entries(tools).map(([id, tool]) => ({
      toolCallId: id,
      toolName: tool.toolName,
      args: tool.args,
    })),
    ...branchCallsOf(selectActiveBranch(s)).last,
    ...Object.values(streaming?.blocks ?? {}).flatMap((block) =>
      block.type === "toolCall"
        ? [
            {
              toolCallId: block.id,
              toolName: block.name,
              args: block.call?.arguments,
              argsText: block.argsText,
              streaming: block.call === undefined,
            },
          ]
        : [],
    ),
  ];
  const seen = new Set<string>();
  return candidates.filter((call) => {
    if (seen.has(call.toolCallId)) return false;
    seen.add(call.toolCallId);
    return isActive(toolStatus(s, call.toolCallId, call.streaming));
  });
}

/** What the live-status row shows (`docs/design/09-ui-overhaul.md`, "Live-status row"). */
export type LiveActivity = {
  /** A row in the transcript shimmers already: a call running or streaming, or live thinking. */
  rowShimmers: boolean;
} & (
  | { kind: "compacting" | "thinking" | "working" }
  | { kind: "retrying"; retry: NonNullable<LiveRun["retry"]> }
  /** The first running call. */
  | { kind: "tool"; call: ActiveCall }
);

/** Undefined unless a run is active or a compaction or retry is pending. */
export const selectLiveActivity = (s: ConversationState): LiveActivity | undefined => {
  const { run, streaming } = s.live;
  if (!run.active && !run.compaction && !run.retry) return undefined;
  const thinking = Object.values(streaming?.blocks ?? {}).some(
    (block) => block.type === "thinking" && !block.done,
  );
  const call = activeCalls(s)[0];
  const rowShimmers = thinking || call !== undefined;
  if (run.compaction) return { kind: "compacting", rowShimmers };
  if (run.retry) return { kind: "retrying", retry: run.retry, rowShimmers };
  if (thinking) return { kind: "thinking", rowShimmers };
  if (call) return { kind: "tool", call, rowShimmers };
  return { kind: "working", rowShimmers };
};
