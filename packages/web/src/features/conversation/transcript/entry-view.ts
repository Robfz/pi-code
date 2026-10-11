/**
 * Which committed entries other than user and assistant messages the transcript shows, and as
 * what (`docs/design/03-web-client.md`, "Transcript rendering"). `selectTurns` makes a step of
 * each; `renderEntry` renders it.
 */

import type { BashExecutionMessage, CustomMessageEntry, SessionEntry } from "@pi-code/protocol";

export type EntryView =
  | { kind: "bash"; bash: BashExecutionMessage }
  | {
      kind: "custom";
      customType: string;
      content: CustomMessageEntry["content"];
      details?: unknown;
    }
  | { kind: "compaction"; tokensBefore: number; summary: string }
  | { kind: "branch-summary"; summary: string }
  | { kind: "model-change"; provider: string; modelId: string }
  | { kind: "thinking-level"; thinkingLevel: string };

/**
 * How the transcript shows an entry: `!cmd` runs, custom messages with `display: true`,
 * compaction and branch summaries, model and thinking level changes. Undefined for everything
 * else: user and assistant messages (turns), tool results (paired with their call), system
 * messages, labels (badges on their targets), hidden custom entries, session info, usage.
 */
export function entryView(entry: SessionEntry): EntryView | undefined {
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      switch (message.role) {
        case "bashExecution":
          return { kind: "bash", bash: message };
        case "custom":
          return message.display
            ? {
                kind: "custom",
                customType: message.customType,
                content: message.content,
                details: message.details,
              }
            : undefined;
        case "compactionSummary":
          return {
            kind: "compaction",
            tokensBefore: message.tokensBefore,
            summary: message.summary,
          };
        case "branchSummary":
          return { kind: "branch-summary", summary: message.summary };
        default:
          return undefined;
      }
    }
    case "custom_message":
      return entry.display
        ? {
            kind: "custom",
            customType: entry.customType,
            content: entry.content,
            details: entry.details,
          }
        : undefined;
    case "compaction":
      return { kind: "compaction", tokensBefore: entry.tokensBefore, summary: entry.summary };
    case "branch_summary":
      return { kind: "branch-summary", summary: entry.summary };
    case "model_change":
      return { kind: "model-change", provider: entry.provider, modelId: entry.modelId };
    case "thinking_level_change":
      return { kind: "thinking-level", thinkingLevel: entry.thinkingLevel };
    default:
      return undefined;
  }
}
