/**
 * Selectors over the conversation store. Derived values are memoized on the identity of the
 * slice they derive from (the reducers keep untouched slices identical), so components can
 * subscribe to them without re-rendering on unrelated events such as token deltas.
 */

import {
  activeBranch,
  type LabelEntry,
  type SessionEntry,
  type ToolResultMessage,
  type Transcript,
} from "@pi-code/protocol";
import { subagentCost } from "@/lib/subagent-details";
import type { ConversationState } from "./conversation-store";

function memoByIdentity<K extends object, V>(compute: (key: K) => V): (key: K) => V {
  const cache = new WeakMap<K, V>();
  return (key) => {
    let value = cache.get(key);
    if (value === undefined) {
      value = compute(key);
      cache.set(key, value);
    }
    return value;
  };
}

const branchOf = memoByIdentity((transcript: Transcript) => activeBranch(transcript));

const toolResultsOf = memoByIdentity((entries: SessionEntry[]) => {
  const results = new Map<string, ToolResultMessage>();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      results.set(entry.message.toolCallId, entry.message);
    }
  }
  return results;
});

const labelsOf = memoByIdentity((entries: SessionEntry[]) => {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "label") continue;
    const { targetId, label } = entry as LabelEntry;
    if (label === undefined || label === "") labels.delete(targetId);
    else labels.set(targetId, label);
  }
  return labels;
});

/** Entries from the root to the current leaf. */
export const selectActiveBranch = (s: ConversationState): SessionEntry[] => branchOf(s.transcript);

/** Committed tool results by `toolCallId` (all branches). */
export const selectToolResults = (s: ConversationState): Map<string, ToolResultMessage> =>
  toolResultsOf(s.transcript.entries);

/** Current label per target entry id. */
export const selectLabels = (s: ConversationState): Map<string, string> =>
  labelsOf(s.transcript.entries);

/**
 * A run is in progress (prompts need a `streamingBehavior`). `live.run.active` follows the same
 * `agent_start` / `agent_settled` events as the cached `state.isStreaming`, and is also cleared
 * when pi exits, which the cached state isn't.
 */
export const selectIsRunning = (s: ConversationState): boolean => s.live.run.active;

export const selectStreaming = (s: ConversationState) => s.live.streaming;
export const selectPendingUser = (s: ConversationState) => s.live.pendingUser;
export const selectTools = (s: ConversationState) => s.live.tools;
export const selectQueue = (s: ConversationState) => s.live.queue;
export const selectDialogs = (s: ConversationState) => s.live.dialogs;
export const selectStatuses = (s: ConversationState) => s.live.statuses;
export const selectWidgets = (s: ConversationState) => s.live.widgets;
export const selectNotices = (s: ConversationState) => s.live.notices;
export const selectEditorText = (s: ConversationState) => s.live.editorText;
export const selectRun = (s: ConversationState) => s.live.run;
export const selectBash = (s: ConversationState) => s.live.bash;
export const selectAgent = (s: ConversationState) => s.agent;
export const selectConnection = (s: ConversationState) => s.connection;

const toolCallIdsOf = memoByIdentity((branch: SessionEntry[]) => {
  const ids = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const block of entry.message.content) if (block.type === "toolCall") ids.add(block.id);
  }
  return ids;
});

/** Ids of tool calls in committed assistant messages on the active branch. */
export const selectBranchToolCallIds = (s: ConversationState): Set<string> =>
  toolCallIdsOf(selectActiveBranch(s));

const committedSubagentSpendOf = memoByIdentity((entries: SessionEntry[]) => {
  let cost = 0;
  let hasCall = false;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "toolResult" || message.toolName !== "subagent") continue;
    cost += subagentCost(message);
    hasCall = true;
  }
  return { cost, hasCall };
});

/**
 * Cumulative `subagent` tool cost: committed results on all branches (like pi's session cost)
 * plus calls not committed yet, from their result or latest partial result. Undefined when the
 * conversation has no subagent call.
 */
export const selectSubagentSpend = (s: ConversationState): number | undefined => {
  const committed = committedSubagentSpendOf(s.transcript.entries);
  let spend = committed.hasCall ? committed.cost : undefined;
  // `live.tools` drops a call in the same update that appends its result entry, so no overlap.
  for (const run of Object.values(s.live.tools)) {
    if (run.toolName !== "subagent") continue;
    spend = (spend ?? 0) + subagentCost(run.result ?? run.partialResult);
  }
  return spend;
};

/** Session name: pi's state once known (it tracks renames and session switches), else the agent's. */
export const selectSessionName = (s: ConversationState): string | undefined =>
  s.state ? s.state.sessionName : s.agent.sessionName;
