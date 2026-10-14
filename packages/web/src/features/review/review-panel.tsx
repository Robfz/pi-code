/**
 * The review panel (`docs/design/07-code-review.md`, "Review panel"): the tabs (Changes and Files,
 * plus Tree in the desktop pane), a Refresh button for the Changes and Files tabs and the active
 * tab's view. The desktop pane and the phone page host it, each adding its own controls to the
 * header.
 */

import { type QueryKey, useIsFetching, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { TreeView } from "@/features/tree/tree-view";
import { queryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { ScreenHeader } from "@/routes/placeholder";
import { ChangesView } from "./changes-view";
import { FilesView } from "./files-view";
import { PAGE_TABS, type ReviewTab, TAB_LABEL, useReview, useReviewStore } from "./review-state";

/** The queries the Refresh button refetches, per tab; the tree follows the live store. */
function tabQueries(agentId: string, tab: ReviewTab): QueryKey[] {
  switch (tab) {
    case "changes":
      return [queryKeys.gitDiffs(agentId), queryKeys.gitBranches(agentId)];
    case "files":
      return [queryKeys.fileContents(agentId), queryKeys.fileSearches(agentId)];
    case "tree":
      return [];
  }
}

export function ReviewPanel({
  agentId,
  tabs = PAGE_TABS,
  leading,
  trailing,
  onAdded,
  className,
}: {
  agentId: string;
  /** The tabs offered; a stored tab outside them shows Changes. */
  tabs?: readonly ReviewTab[];
  /** Header controls before the tabs. */
  leading?: ReactNode;
  /** Header controls after Refresh. */
  trailing?: ReactNode;
  /** After a reference is inserted. */
  onAdded?(): void;
  className?: string;
}) {
  const stored = useReview(agentId).tab;
  const tab = tabs.includes(stored) ? stored : "changes";
  const queryClient = useQueryClient();
  const queries = tabQueries(agentId, tab);
  const fetching =
    useIsFetching({
      predicate: (query) =>
        queries.some((key) => key.every((part, i) => query.queryKey[i] === part)),
    }) > 0;
  const refresh = () => {
    for (const queryKey of queries) void queryClient.refetchQueries({ queryKey, type: "active" });
  };

  return (
    <div className={cn("flex flex-col", className)}>
      <ScreenHeader>
        {leading}
        <div role="tablist" aria-label="Review" className="flex flex-1 items-center gap-1">
          {tabs.map((value) => (
            <Button
              key={value}
              role="tab"
              aria-selected={tab === value}
              variant={tab === value ? "secondary" : "ghost"}
              size="sm"
              onClick={() => useReviewStore.getState().setTab(agentId, value)}
            >
              {TAB_LABEL[value]}
            </Button>
          ))}
        </div>
        {queries.length > 0 && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh"
            disabled={fetching || agentId === ""}
            onClick={refresh}
          >
            <RefreshCwIcon className={cn(fetching && "animate-spin")} />
          </Button>
        )}
        {trailing}
      </ScreenHeader>
      {/* `relative` so absolutely positioned descendants (`sr-only` labels) are clipped here
          instead of overflowing the document. */}
      <div
        role="tabpanel"
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]"
      >
        {tab === "changes" && (
          <div className="pb-6">
            <ChangesView agentId={agentId} {...(onAdded && { onAdded })} />
          </div>
        )}
        {tab === "files" && (
          <div className="flex flex-col px-2 pt-3 pb-6">
            <FilesView agentId={agentId} {...(onAdded && { onAdded })} />
          </div>
        )}
        {tab === "tree" && <TreeView />}
      </div>
    </div>
  );
}
