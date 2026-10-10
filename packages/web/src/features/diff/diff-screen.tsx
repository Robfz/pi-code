/**
 * `/agents/$agentId/diff`: the Changes tab (`docs/design/07-code-review.md`) as a page, with a
 * back link to the conversation and a Refresh button.
 */

import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronLeftIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChangesView } from "@/features/review/changes-view";
import { queryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { ScreenHeader } from "@/routes/placeholder";

export function DiffScreen() {
  const { agentId = "" } = useParams({ strict: false }) as { agentId?: string };
  const queryClient = useQueryClient();
  const fetching = useIsFetching({ queryKey: queryKeys.review(agentId) }) > 0;
  const refresh = () => {
    void queryClient.refetchQueries({ queryKey: queryKeys.review(agentId), type: "active" });
    void queryClient.refetchQueries({ queryKey: queryKeys.gitBranches(agentId), type: "active" });
  };

  return (
    <div className="flex min-h-dvh w-full flex-col">
      <ScreenHeader>
        <Button variant="ghost" size="icon" asChild>
          <Link to="/agents/$agentId" params={{ agentId }} aria-label="Back to conversation">
            <ChevronLeftIcon />
          </Link>
        </Button>
        <h1 className="flex-1 text-sm font-medium">Git diff</h1>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh"
          disabled={fetching || agentId === ""}
          onClick={refresh}
        >
          <RefreshCwIcon className={cn(fetching && "animate-spin")} />
        </Button>
      </ScreenHeader>
      <div className="mx-auto flex w-full max-w-6xl flex-col px-2 pt-3 pb-6">
        <ChangesView agentId={agentId} />
      </div>
    </div>
  );
}
