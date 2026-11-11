import type { AgentInfo } from "@pi-code/protocol";
import { useIsMutating, useMutation } from "@tanstack/react-query";
import { GitPullRequestIcon, LoaderIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useShowOpenedAgent } from "@/features/catalog/use-open-agent";
import { openPrGuide } from "@/features/review/review-state";
import { errorMessage, startPrReview } from "@/lib/api";
import { useIsDesktop } from "@/lib/use-media-query";

interface PrReviewActions {
  /** Opens the "Review PR" dialog. */
  openPrReview(): void;
}

const PrReviewContext = createContext<PrReviewActions | null>(null);

const START_KEY = ["start-pr-review"] as const;

function PrReviewForm({ onStarted }: { onStarted: (agent: AgentInfo) => void }) {
  const [url, setUrl] = useState("");
  const id = useId();
  const start = useMutation({
    mutationKey: START_KEY,
    mutationFn: startPrReview,
    onSuccess: onStarted,
  });
  const trimmed = url.trim();
  const canSubmit = trimmed !== "" && !start.isPending;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) start.mutate(trimmed);
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-url`} className="text-xs font-medium text-muted-foreground">
          Pull request URL
        </label>
        <Input
          id={`${id}-url`}
          autoFocus
          type="url"
          inputMode="url"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            if (start.isError) start.reset();
          }}
          placeholder="https://github.com/owner/repo/pull/123"
          disabled={start.isPending}
          aria-invalid={start.isError}
          aria-describedby={start.isError ? `${id}-error` : undefined}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className="h-10 font-mono text-base md:text-sm"
        />
      </div>
      {start.isError && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {errorMessage(start.error)}
        </p>
      )}
      <Button type="submit" className="h-10" disabled={!canSubmit}>
        {start.isPending ? <LoaderIcon className="animate-spin" /> : <GitPullRequestIcon />}
        {start.isPending ? "Preparing…" : "Review"}
      </Button>
    </form>
  );
}

/**
 * "Review PR": one URL field, then `POST /api/pr-reviews`, which creates the PR's review worktree
 * and a conversation attached to it; the conversation opens with its review pane on the Guide
 * tab. Can't be dismissed while the request runs.
 */
function PrReviewDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const desktop = useIsDesktop();
  const show = useShowOpenedAgent((agent) => openPrGuide(agent.id, desktop));
  const starting = useIsMutating({ mutationKey: START_KEY }) > 0;
  // Counts opens, so each one keys a fresh, empty form.
  const [opens, setOpens] = useState({ count: 0, open });
  if (opens.open !== open) setOpens({ count: opens.count + (open ? 1 : 0), open });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || !starting) onOpenChange(next);
      }}
    >
      <DialogContent data-testid="pr-review-dialog" className="sm:max-w-md">
        <DialogHeader className="pr-8">
          <DialogTitle>Review PR</DialogTitle>
          <DialogDescription>
            Checks the PR's branch out in a new worktree of its repo and opens a conversation there
            with the PR's guide.
          </DialogDescription>
        </DialogHeader>
        <PrReviewForm
          key={opens.count}
          onStarted={(agent) => {
            onOpenChange(false);
            show(agent);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Hosts the "Review PR" dialog once at the app root, for the `pr.review` shortcut and the Home
 * buttons alike.
 */
export function PrReviewProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const actions = useMemo(() => ({ openPrReview: () => setOpen(true) }), []);
  return (
    <PrReviewContext.Provider value={actions}>
      {children}
      <PrReviewDialog open={open} onOpenChange={setOpen} />
    </PrReviewContext.Provider>
  );
}

export function usePrReview(): PrReviewActions {
  const actions = useContext(PrReviewContext);
  if (actions === null) throw new Error("usePrReview needs a PrReviewProvider");
  return actions;
}

/** "Review PR" beside Home's "New conversation". */
export function ReviewPrButton({ className }: { className?: string }) {
  const { openPrReview } = usePrReview();
  return (
    <Button variant="outline" className={className} onClick={openPrReview}>
      <GitPullRequestIcon /> Review PR
    </Button>
  );
}
