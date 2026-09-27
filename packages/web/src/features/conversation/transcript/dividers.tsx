import type { ReactNode } from "react";
import { Markdown } from "@/components/markdown";

/** Full-width divider with an expandable summary (compaction, branch summary). */
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
    <details data-testid={testId} className="group/divider">
      <summary className="flex cursor-pointer list-none items-center gap-3 text-xs text-muted-foreground select-none">
        <span className="h-px flex-1 bg-border" />
        <span>{label}</span>
        <span className="h-px flex-1 bg-border" />
      </summary>
      <div className="mt-2 rounded-lg bg-muted/40 px-3 py-2">
        <Markdown text={summary} />
      </div>
    </details>
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

export function formatTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
}
