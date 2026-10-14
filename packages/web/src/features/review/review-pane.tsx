/**
 * The desktop review pane (`docs/design/07-code-review.md`, "Desktop pane"): the review panel with
 * every tab, Tree included, beside the conversation, with a Close button.
 */

import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReviewPanel } from "./review-panel";
import { REVIEW_TABS, useReview, useReviewStore } from "./review-state";

export function ReviewPane({ agentId }: { agentId: string }) {
  const { tab } = useReview(agentId);
  const close = () => {
    useReviewStore.getState().togglePane(agentId);
    // The Close button unmounts; focus moves to the rail button that reopens this tab.
    document.querySelector<HTMLElement>(`[data-rail-tab="${tab}"]`)?.focus();
  };
  return (
    <aside aria-label="Review" className="flex h-dvh min-w-0 flex-1 flex-col border-l">
      <ReviewPanel
        agentId={agentId}
        tabs={REVIEW_TABS}
        className="min-h-0 flex-1"
        trailing={
          <Button variant="ghost" size="icon" aria-label="Close pane" onClick={close}>
            <XIcon />
          </Button>
        }
      />
    </aside>
  );
}
