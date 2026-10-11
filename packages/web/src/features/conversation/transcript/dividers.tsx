import type { ReactNode } from "react";
import { CollapsibleRow } from "@/components/collapsible-row";
import { Markdown } from "@/components/markdown";

/**
 * Full-width divider with an expandable summary (compaction, branch summary). The summary's
 * markdown renders only once expanded: long sessions carry many of them.
 */
export function SummaryDivider({
  label,
  summary,
  testId,
}: {
  label: string;
  summary: string;
  testId: string;
}) {
  return (
    <CollapsibleRow
      data-testid={testId}
      labelClassName="items-center gap-3"
      label={
        <>
          <span className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className="h-px flex-1 bg-border" />
        </>
      }
    >
      <div className="mt-1 mb-2 rounded-lg bg-muted/40 px-3 py-2">
        <Markdown text={summary} />
      </div>
    </CollapsibleRow>
  );
}

/** Inline muted marker (model / thinking level changes). */
export function Marker({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div data-testid={testId} className="text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}
