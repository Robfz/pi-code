import type { PrAttachment } from "@pi-code/protocol";
import { useMutation } from "@tanstack/react-query";
import { GitPullRequestIcon, LoaderIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { errorMessage, refreshPr } from "@/lib/api";
import { isOutdated } from "./pr";

/**
 * The attached PR's header line in the Changes tab's PR mode and the Guide tab
 * (`docs/design/10-pr-review.md`, "PR mode"): `#N title`, the number linking to the PR, a state
 * chip once merged or closed, and "Outdated · Refresh" while the PR has pushes newer than the
 * pinned head. Refresh re-pins the PR, which also regenerates its guide, and toasts the server's
 * warning when a review worktree's checkout stays behind.
 */
export function PrHeader({ agentId, pr }: { agentId: string; pr: PrAttachment }) {
  const refresh = useMutation({
    mutationFn: () => refreshPr(agentId),
    onSuccess: ({ worktreeWarning }) => {
      if (worktreeWarning !== undefined) toast.warning(worktreeWarning);
    },
    onError: (error) => toast.error(`Couldn't refresh the PR: ${errorMessage(error)}`),
  });
  return (
    <div data-testid="pr-header" className="flex h-9 items-center gap-2 border-b px-3 text-xs">
      <GitPullRequestIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 truncate">
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-link hover:underline"
        >
          #{pr.number}
        </a>{" "}
        <span title={pr.title}>{pr.title}</span>
      </p>
      {pr.state !== "open" && (
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">
          {pr.state === "merged" ? "Merged" : "Closed"}
        </span>
      )}
      {isOutdated(pr) && (
        <span className="flex shrink-0 items-center gap-1 text-status-input">
          Outdated ·
          <Button
            size="xs"
            variant="link"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
            className="h-auto px-0"
          >
            {refresh.isPending && <LoaderIcon className="animate-spin" />}
            Refresh
          </Button>
        </span>
      )}
    </div>
  );
}
