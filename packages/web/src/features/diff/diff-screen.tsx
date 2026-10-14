/**
 * `/agents/$agentId/diff`: the review panel as a page on phones (`docs/design/07-code-review.md`,
 * "Phone page"), with a back link to the conversation. Adding a reference returns there. On
 * desktop the route opens the conversation's review pane instead.
 */

import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ReviewPanel } from "@/features/review/review-panel";
import { PAGE_TABS, useReviewStore } from "@/features/review/review-state";
import { useIsDesktop } from "@/lib/use-media-query";

export function DiffScreen() {
  const { agentId = "" } = useParams({ strict: false }) as { agentId?: string };
  const navigate = useNavigate();
  const desktop = useIsDesktop();

  useEffect(() => {
    if (!desktop) return;
    const review = useReviewStore.getState();
    const stored = review.reviews[agentId]?.tab ?? "changes";
    // A tab the page has: the stored one, or Changes for the pane's Tree.
    review.openPane(agentId, PAGE_TABS.includes(stored) ? stored : "changes");
    void navigate({ to: "/agents/$agentId", params: { agentId }, replace: true });
  }, [desktop, agentId, navigate]);

  if (desktop) return null;
  return (
    <ReviewPanel
      agentId={agentId}
      className="h-dvh w-full"
      leading={
        <Button variant="ghost" size="icon" asChild>
          <Link to="/agents/$agentId" params={{ agentId }} aria-label="Back to conversation">
            <ChevronLeftIcon />
          </Link>
        </Button>
      }
      onAdded={() => void navigate({ to: "/agents/$agentId", params: { agentId } })}
    />
  );
}
