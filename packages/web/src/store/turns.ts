/**
 * The transcript as turns (`docs/design/09-ui-overhaul.md`, "Turns"): the active branch split at
 * each user message, each turn a list of steps.
 */

import {
  type AssistantMessage,
  effectiveStopReason,
  type SessionEntry,
  type UserMessage,
} from "@pi-code/protocol";
import { countPatchLines } from "@/components/diff/parse-patch";
import { lineCount } from "@/lib/content";
import { asRecord, str } from "@/lib/record";
import { SPAWN_TOOL_NAME, subagentCost } from "@/lib/subagent-details";
import type { ConversationState } from "./conversation-store";
import { memoByIdentity, selectActiveBranch } from "./selectors";

/** One thing a turn shows. `entryId` is the committed entry it comes from. */
export type Step =
  | { kind: "text"; key: string; entryId?: string; text: string; streaming?: boolean }
  | {
      kind: "thinking";
      key: string;
      entryId?: string;
      text: string;
      redacted: boolean;
      /** A streaming block not done yet. */
      live?: boolean;
      startedAt?: number;
      endedAt?: number;
      /** `${message timestamp}:${content index}`: its `thinkingMs` key once committed. */
      durationKey?: string;
    }
  | {
      kind: "tool";
      key: string;
      entryId?: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      /** Raw arguments while the assistant streams the call. */
      argsText?: string;
      streaming?: boolean;
    }
  /** An assistant message's error, aborted or truncated notice. */
  | { kind: "stop"; key: string; entryId: string; message: AssistantMessage }
  /** Any other entry the transcript shows (`!cmd`, custom messages, dividers, markers). */
  | { kind: "entry"; key: string; entryId: string; entry: SessionEntry };

export interface Turn {
  /** The user entry's id; "start" for entries before the first user message. */
  id: string;
  user?: UserMessage;
  /** The turn's entries after its user message. */
  entries: SessionEntry[];
  steps: Step[];
}

/** Whether the transcript shows an entry other than a user or assistant message. */
function isShownEntry(entry: SessionEntry): boolean {
  switch (entry.type) {
    case "message":
      switch (entry.message.role) {
        case "bashExecution":
        case "compactionSummary":
        case "branchSummary":
          return true;
        case "custom":
          return entry.message.display;
        default:
          return false;
      }
    case "custom_message":
      return entry.display;
    case "compaction":
    case "branch_summary":
    case "model_change":
    case "thinking_level_change":
      return true;
    default:
      return false;
  }
}

/** Key of a text or thinking block, shared by its streaming and committed forms. */
export function blockKey(timestamp: number | undefined, index: number): string {
  return `${timestamp ?? "live"}:${index}`;
}

function assistantSteps(entryId: string, message: AssistantMessage): Step[] {
  const steps: Step[] = [];
  message.content.forEach((block, index) => {
    const key = blockKey(message.timestamp, index);
    if (block.type === "text") {
      if (block.text.trim() !== "") steps.push({ kind: "text", key, entryId, text: block.text });
    } else if (block.type === "thinking") {
      const redacted = block.redacted === true;
      if (!redacted && block.thinking.trim() === "") return;
      steps.push({
        kind: "thinking",
        key,
        entryId,
        text: block.thinking,
        redacted,
        durationKey: key,
      });
    } else if (block.type === "toolCall") {
      steps.push({
        kind: "tool",
        key: block.id,
        entryId,
        toolCallId: block.id,
        toolName: block.name,
        args: block.arguments,
      });
    }
  });
  const reason = effectiveStopReason(message);
  if (reason === "error" || reason === "aborted" || reason === "length") {
    steps.push({ kind: "stop", key: `${entryId}:stop`, entryId, message });
  }
  return steps;
}

/** An entry's steps, memoized on it so unchanged entries keep their step objects. */
const entrySteps = memoByIdentity((entry: SessionEntry): Step[] => {
  if (entry.type === "message" && entry.message.role === "assistant") {
    return assistantSteps(entry.id, entry.message);
  }
  return isShownEntry(entry) ? [{ kind: "entry", key: entry.id, entryId: entry.id, entry }] : [];
});

function buildTurns(branch: SessionEntry[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "user") {
      current = { id: entry.id, user: entry.message, entries: [], steps: [] };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { id: "start", entries: [], steps: [] };
      turns.push(current);
    }
    current.entries.push(entry);
    current.steps.push(...entrySteps(entry));
  }
  return turns;
}

const turnsOf = memoByIdentity(buildTurns);

/** Turns of the active branch (memoized on it). */
export const selectTurns = (s: ConversationState): Turn[] => turnsOf(selectActiveBranch(s));

export interface TurnStats {
  /** From the user message to the end of the last assistant message. */
  durationMs?: number;
  /** Assistant usage plus `spawn` results' subagent usage. */
  cost: number;
  /** Distinct paths of successful `edit` and `write` calls, with their line counts. */
  files?: { count: number; additions: number; deletions: number };
  /** The text steps after the last thinking or tool step, joined by a blank line. */
  finalText?: string;
}

/** Final text of a list of steps (see `TurnStats.finalText`). */
export function finalText(steps: Step[]): string | undefined {
  let start = 0;
  steps.forEach((step, index) => {
    if (step.kind === "thinking" || step.kind === "tool") start = index + 1;
  });
  const texts = steps.slice(start).flatMap((step) => (step.kind === "text" ? [step.text] : []));
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

export function turnStats(turn: Turn): TurnStats {
  let cost = 0;
  let lastAssistant: AssistantMessage | undefined;
  const calls = new Map<string, unknown>();
  const paths = new Set<string>();
  let additions = 0;
  let deletions = 0;

  for (const entry of turn.entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      lastAssistant = message;
      cost += message.usage?.cost?.total ?? 0;
      for (const block of message.content) {
        if (block.type === "toolCall") calls.set(block.id, block.arguments);
      }
    } else if (message.role === "toolResult") {
      if (message.toolName === SPAWN_TOOL_NAME) cost += subagentCost(message);
      if (message.isError || (message.toolName !== "edit" && message.toolName !== "write")) {
        continue;
      }
      const args = calls.get(message.toolCallId);
      const path = str(args, "path") ?? str(args, "file_path");
      if (!path) continue;
      paths.add(path);
      if (message.toolName === "write") {
        additions += lineCount(str(args, "content") ?? "");
      } else {
        const patch = str(asRecord(message.details), "patch");
        if (patch) {
          const counts = countPatchLines(patch);
          additions += counts.additions;
          deletions += counts.deletions;
        }
      }
    }
  }

  return {
    durationMs:
      turn.user && lastAssistant
        ? lastAssistant.timestamp + (lastAssistant.durationMs ?? 0) - turn.user.timestamp
        : undefined,
    cost,
    files: paths.size > 0 ? { count: paths.size, additions, deletions } : undefined,
    finalText: finalText(turn.steps),
  };
}
