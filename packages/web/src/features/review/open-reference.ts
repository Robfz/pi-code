import type { CodeRef } from "@pi-code/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { toast } from "sonner";
import { useIsDesktop } from "@/lib/use-media-query";
import { useConversation } from "@/store/context";
import { useReviewStore } from "./review-state";

/**
 * Opens a reference's lines in the Files tab (`docs/design/07-code-review.md`, "Opening"): in the
 * review pane on desktop, on the review page on phones. A version-named reference opens the
 * current file, with a toast saying so.
 */
export function useOpenReference(): (ref: CodeRef) => void {
  const agentId = useConversation((s) => s.agentId);
  const desktop = useIsDesktop();
  const navigate = useNavigate();
  return useCallback(
    (ref: CodeRef) => {
      const review = useReviewStore.getState();
      review.openFile(agentId, ref.path, { start: ref.start, end: ref.end });
      if (desktop) review.openPane(agentId);
      else void navigate({ to: "/agents/$agentId/diff", params: { agentId } });
      if (ref.rev !== undefined)
        toast(`That reference points at version ${ref.rev}; showing the current file.`);
    },
    [agentId, desktop, navigate],
  );
}
