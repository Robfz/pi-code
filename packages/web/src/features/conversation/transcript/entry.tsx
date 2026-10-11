import type { SessionEntry } from "@pi-code/protocol";
import type { ReactNode } from "react";
import { formatTokens } from "@/lib/time";
import { BashExecutionView } from "./bash-execution";
import { CustomMessageView } from "./custom-message";
import { Marker, SummaryDivider } from "./dividers";
import { entryView } from "./entry-view";

/**
 * Rendering of a committed entry that isn't a user or assistant message (those make up turns),
 * as `entryView` describes it; null for entries the transcript doesn't show.
 */
export function renderEntry(entry: SessionEntry): ReactNode {
  const view = entryView(entry);
  switch (view?.kind) {
    case undefined:
      return null;
    case "bash":
      return <BashExecutionView bash={view.bash} />;
    case "custom":
      return (
        <CustomMessageView
          customType={view.customType}
          content={view.content}
          details={view.details}
        />
      );
    case "compaction":
      return (
        <SummaryDivider
          testId="compaction"
          label={`Context compacted (${formatTokens(view.tokensBefore)} tokens)`}
          summary={view.summary}
        />
      );
    case "branch-summary":
      return (
        <SummaryDivider testId="branch-summary" label="Branch summary" summary={view.summary} />
      );
    case "model-change":
      return (
        <Marker testId="model-change">
          Model · {view.provider}/{view.modelId}
        </Marker>
      );
    case "thinking-level":
      return <Marker testId="thinking-change">Thinking · {view.thinkingLevel}</Marker>;
  }
}
