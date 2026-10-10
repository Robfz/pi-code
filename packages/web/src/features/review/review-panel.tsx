/**
 * The review panel (`docs/design/07-code-review.md`, "Review panel"): the Changes and Files tabs,
 * a Refresh button for the active tab and the active tab's view. The desktop pane and the phone
 * page host it, each adding its own controls to the header.
 */

import { type QueryKey, useIsFetching, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { ScreenHeader } from "@/routes/placeholder";
import { ChangesView } from "./changes-view";
import { FilesView } from "./files-view";
import { type ReviewTab, useReview, useReviewStore } from "./review-state";

const TABS: [ReviewTab, string][] = [
  ["changes", "Changes"],
  ["files", "Files"],
];

/** The queries the Refresh button refetches, per tab. */
function tabQueries(agentId: string, tab: ReviewTab): QueryKey[] {
  return tab === "changes"
    ? [[...queryKeys.review(agentId), "diff"], queryKeys.gitBranches(agentId)]
    : [
        [...queryKeys.review(agentId), "file"],
        ["agent", agentId, "files"],
      ];
}

export function ReviewPanel({
  agentId,
  leading,
  trailing,
  onAdded,
  className,
}: {
  agentId: string;
  /** Header controls before the tabs. */
  leading?: ReactNode;
  /** Header controls after Refresh. */
  trailing?: ReactNode;
  /** After a reference is inserted. */
  onAdded?(): void;
  className?: string;
}) {
  const { tab } = useReview(agentId);
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
          {TABS.map(([value, label]) => (
            <Button
              key={value}
              role="tab"
              aria-selected={tab === value}
              variant={tab === value ? "secondary" : "ghost"}
              size="sm"
              onClick={() => useReviewStore.getState().setTab(agentId, value)}
            >
              {label}
            </Button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh"
          disabled={fetching || agentId === ""}
          onClick={refresh}
        >
          <RefreshCwIcon className={cn(fetching && "animate-spin")} />
        </Button>
        {trailing}
      </ScreenHeader>
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col px-2 pt-3 pb-6">
          {tab === "changes" ? (
            <ChangesView agentId={agentId} {...(onAdded && { onAdded })} />
          ) : (
            <FilesView agentId={agentId} {...(onAdded && { onAdded })} />
          )}
        </div>
      </div>
    </div>
  );
}
