/**
 * The desktop review pane (`docs/design/07-code-review.md`, "Desktop pane"): the review panel
 * beside the conversation, with a Close button.
 */

import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReviewPanel } from "./review-panel";
import { useReviewStore } from "./review-state";

export function ReviewPane({ agentId }: { agentId: string }) {
  return (
    <aside aria-label="Review" className="flex h-dvh w-1/2 shrink-0 flex-col border-l">
      <ReviewPanel
        agentId={agentId}
        className="min-h-0 flex-1"
        trailing={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close changes"
            onClick={() => useReviewStore.getState().togglePane(agentId)}
          >
            <XIcon />
          </Button>
        }
      />
    </aside>
  );
}
