/**
 * The transcript as turns (`docs/design/09-ui-overhaul.md`, "Turns"): the active branch split at
 * each user message, each turn a list of steps.
 */

import {
  type AssistantMessage,
  effectiveStopReason,
  type SessionEntry,
  thinkingKey,
  type UserMessage,
} from "@pi-code/protocol";
import { countPatchLines } from "@/components/diff/parse-patch";
import { entryView } from "@/features/conversation/transcript/entry-view";
import { lineCount } from "@/lib/content";
import { argPath, asRecord, str } from "@/lib/record";
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
      /** Its `thinkingMs` key (`thinkingKey`) once committed. */
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
  /** Any other entry the transcript shows (`entryView`: `!cmd`, custom messages, dividers, markers). */
  | { kind: "entry"; key: string; entryId: string; entry: SessionEntry };

export interface Turn {
  /** The user entry's id; "start" for entries before the first user message. */
  id: string;
  user?: UserMessage;
  /** The turn's entries after its user message. */
  entries: SessionEntry[];
  steps: Step[];
}

/**
 * Key of a text or thinking block, shared by its streaming and committed forms: its `thinkingKey`
 * (a streaming message without a timestamp has `live:` keys).
 */
export function blockKey(timestamp: number | undefined, index: number): string {
  return timestamp === undefined ? `live:${index}` : thinkingKey(timestamp, index);
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
  return entryView(entry) ? [{ kind: "entry", key: entry.id, entryId: entry.id, entry }] : [];
});

/** The latest turn built from each turn's first entry, reused while its entries are the same. */
const builtTurns = new WeakMap<SessionEntry, Turn>();

function sameEntries(a: readonly SessionEntry[], b: readonly SessionEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * Split at each user message. A turn whose entries are unchanged keeps its identity, so a commit
 * re-renders only the turn it lands in.
 */
function buildTurns(branch: SessionEntry[]): Turn[] {
  const groups: { head: SessionEntry; id: string; user?: UserMessage; entries: SessionEntry[] }[] =
    [];
  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "user") {
      groups.push({ head: entry, id: entry.id, user: entry.message, entries: [] });
      continue;
    }
    if (groups.length === 0) groups.push({ head: entry, id: "start", entries: [] });
    groups.at(-1)?.entries.push(entry);
  }
  return groups.map(({ head, id, user, entries }) => {
    const previous = builtTurns.get(head);
    if (previous && sameEntries(previous.entries, entries)) return previous;
    const turn: Turn = { id, user, entries, steps: entries.flatMap(entrySteps) };
    builtTurns.set(head, turn);
    return turn;
  });
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

/** Index of the last thinking or tool step (-1 without one): the final text comes after it. */
export function lastWorkIndex(steps: readonly Step[]): number {
  return steps.findLastIndex((step) => step.kind === "thinking" || step.kind === "tool");
}

/** Final text of a list of steps (see `TurnStats.finalText`). */
export function finalText(steps: readonly Step[]): string | undefined {
  const texts = steps
    .slice(lastWorkIndex(steps) + 1)
    .flatMap((step) => (step.kind === "text" ? [step.text] : []));
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
      const path = argPath(args);
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
