import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useReviewStore } from "@/features/review/review-state";
import { useIsDesktop } from "@/lib/use-media-query";
import { ScreenHeader } from "@/routes/placeholder";
import { useConversation } from "@/store/context";
import { TreeView } from "./tree-view";

/**
 * `/agents/$agentId/tree`: the tree view as a page on phones, with a back link to the
 * conversation. On desktop the route opens the review pane on its Tree tab instead.
 */
export function TreeScreen() {
  const agentId = useConversation((s) => s.agentId);
  const navigate = useNavigate();
  const desktop = useIsDesktop();

  useEffect(() => {
    if (!desktop) return;
    useReviewStore.getState().openPane(agentId, "tree");
    void navigate({ to: "/agents/$agentId", params: { agentId }, replace: true });
  }, [desktop, agentId, navigate]);

  if (desktop) return null;
  return (
    <div className="flex h-dvh w-full flex-col">
      <ScreenHeader>
        <Button variant="ghost" size="icon" asChild>
          <Link to="/agents/$agentId" params={{ agentId }} aria-label="Back to conversation">
            <ChevronLeftIcon />
          </Link>
        </Button>
        <h1 className="flex-1 text-sm font-medium">Session tree</h1>
      </ScreenHeader>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
        <TreeView />
      </div>
    </div>
  );
}
