import type { SessionEntry } from "@pi-code/protocol";
import { TagIcon } from "lucide-react";
import { memo, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { useConversation } from "@/store/context";
import { selectActiveBranch, selectLabels } from "@/store/selectors";
import { AssistantMessageView } from "./assistant-message";
import { BashExecutionView } from "./bash-execution";
import { CustomMessageView } from "./custom-message";
import { formatTokens, Marker, SummaryDivider } from "./dividers";
import { UserMessageView } from "./user-message";

/**
 * Rendering of one committed entry (`docs/design/03-web-client.md`, "Transcript rendering").
 * Returns null for entries that aren't shown: custom entries, session_info, usage, context
 * edits, labels (shown as badges on their target), system messages, tool results (paired with
 * their call), and custom messages with `display: false`.
 */
export function renderEntry(entry: SessionEntry): ReactNode {
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      switch (message.role) {
        case "user":
          return <UserMessageView message={message} />;
        case "assistant":
          return <AssistantMessageView message={message} />;
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
          // system, toolResult
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
      // label, custom, session_info, usage, context_edit
      return null;
  }
}

const EntryView = memo(function EntryView({
  entry,
  label,
}: {
  entry: SessionEntry;
  label: string | undefined;
}) {
  const content = renderEntry(entry);
  if (content === null) return null;
  return (
    <div data-entry-id={entry.id} className="flex min-w-0 flex-col gap-1">
      {label !== undefined && (
        <Badge variant="outline" className="self-end" data-testid="entry-label">
          <TagIcon /> {label}
        </Badge>
      )}
      {content}
    </div>
  );
});

/** Committed entries of the active branch. */
export function Transcript() {
  const branch = useConversation(selectActiveBranch);
  const labels = useConversation(selectLabels);
  return (
    <div data-testid="transcript" className="flex flex-col gap-4">
      {branch.map((entry) => (
        <EntryView key={entry.id} entry={entry} label={labels.get(entry.id)} />
      ))}
    </div>
  );
}
