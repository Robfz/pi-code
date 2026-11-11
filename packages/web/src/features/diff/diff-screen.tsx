/**
 * `/agents/$agentId/diff`: the review panel as a page on phones (`docs/design/07-code-review.md`,
 * "Phone page"), with a back link to the conversation. Adding a reference returns there. On
 * desktop the route opens the conversation's review pane instead.
 */

import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useConversationPr } from "@/features/review/pr";
import { ReviewPanel } from "@/features/review/review-panel";
import {
  DEFAULT_REVIEW,
  pageTabs,
  paneTabs,
  tabOf,
  useReviewStore,
} from "@/features/review/review-state";
import { useIsDesktop } from "@/lib/use-media-query";

export function DiffScreen() {
  const { agentId = "" } = useParams({ strict: false }) as { agentId?: string };
  const navigate = useNavigate();
  const desktop = useIsDesktop();
  const attached = useConversationPr() !== undefined;

  useEffect(() => {
    if (!desktop) return;
    const review = useReviewStore.getState();
    const entry = review.reviews[agentId] ?? DEFAULT_REVIEW;
    // The tab the page would show: the pane's own, or Changes in place of Tree.
    review.openPane(agentId, tabOf(entry, paneTabs(attached)) === "tree" ? "changes" : undefined);
    void navigate({ to: "/agents/$agentId", params: { agentId }, replace: true });
  }, [desktop, agentId, navigate, attached]);

  if (desktop) return null;
  return (
    <ReviewPanel
      agentId={agentId}
      tabs={pageTabs(attached)}
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
