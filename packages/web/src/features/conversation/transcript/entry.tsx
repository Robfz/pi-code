import type { SessionEntry } from "@pi-code/protocol";
import type { ReactNode } from "react";
import { formatTokens } from "@/lib/time";
import { BashExecutionView } from "./bash-execution";
import { CustomMessageView } from "./custom-message";
import { Marker, SummaryDivider } from "./dividers";

/**
 * Rendering of a committed entry that isn't a user or assistant message (those make up turns):
 * `!cmd` runs, custom messages with `display: true`, compaction and branch summaries, model and
 * thinking level changes. Null for everything else (`docs/design/03-web-client.md`, "Transcript
 * rendering").
 */
export function renderEntry(entry: SessionEntry): ReactNode {
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      switch (message.role) {
        case "bashExecution":
          return <BashExecutionView bash={message} />;
        case "custom":
          return message.display ? (
            <CustomMessageView
              customType={message.customType}
              content={message.content}
              details={message.details}
            />
          ) : null;
        case "compactionSummary":
          return (
            <SummaryDivider
              testId="compaction"
              label={`Context compacted (${formatTokens(message.tokensBefore)} tokens)`}
              summary={message.summary}
            />
          );
        case "branchSummary":
          return (
            <SummaryDivider
              testId="branch-summary"
              label="Branch summary"
              summary={message.summary}
            />
          );
        default:
          // user and assistant (turns), system, toolResult (paired with its call)
          return null;
      }
    }
    case "custom_message":
      return entry.display ? (
        <CustomMessageView
          customType={entry.customType}
          content={entry.content}
          details={entry.details}
        />
      ) : null;
    case "compaction":
      return (
        <SummaryDivider
          testId="compaction"
          label={`Context compacted (${formatTokens(entry.tokensBefore)} tokens)`}
          summary={entry.summary}
        />
      );
    case "branch_summary":
      return (
        <SummaryDivider testId="branch-summary" label="Branch summary" summary={entry.summary} />
      );
    case "model_change":
      return (
        <Marker testId="model-change">
          Model · {entry.provider}/{entry.modelId}
        </Marker>
      );
    case "thinking_level_change":
      return <Marker testId="thinking-change">Thinking · {entry.thinkingLevel}</Marker>;
    default:
      // label (a badge on its target), custom, session_info, usage, context_edit
      return null;
  }
}
