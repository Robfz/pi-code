/**
 * The desktop activity rail (`docs/design/07-code-review.md`, "Desktop pane"): a thin column at
 * the conversation screen's right edge with one button per review pane tab. A button opens the
 * pane on its tab, or closes the pane when that tab is already showing.
 */

import { FileDiffIcon, FolderTreeIcon, ListTreeIcon, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConversation } from "@/store/context";
import { type ReviewTab, TAB_LABEL, useReview, useReviewStore } from "./review-state";

const ITEMS: [ReviewTab, LucideIcon][] = [
  ["changes", FileDiffIcon],
  ["files", FolderTreeIcon],
  ["tree", ListTreeIcon],
];

export function ReviewRail({ agentId }: { agentId: string }) {
  const { paneOpen, tab } = useReview(agentId);
  const dirty = useConversation((s) => s.gitStatus?.dirty === true);
  return (
    <div
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Side panel"
      className="flex h-dvh w-(--rail-width) shrink-0 flex-col items-center border-l bg-background"
    >
      {/* The rail's cell of the header row, the title bar under Window Controls Overlay. It is
          empty, so the window controls may cover it: no inset of its own. Under WCO the controls
          hide most of its bottom border, leaving a stub, so it has none there. */}
      <div className="titlebar box-content h-12 w-full shrink-0 border-b pt-[env(safe-area-inset-top)] [@media(display-mode:window-controls-overlay)]:border-b-0 [--titlebar-left:100vw] [--titlebar-pad:0px] [--titlebar-right:100vw]" />
      <div className="flex flex-col items-center gap-1 py-2">
        {ITEMS.map(([value, Icon]) => {
          const active = paneOpen && tab === value;
          const marked = value === "changes" && dirty;
          return (
            <Tooltip key={value}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-pressed={active}
                  data-rail-tab={value}
                  className="relative text-muted-foreground aria-pressed:bg-sidebar-accent aria-pressed:text-foreground"
                  onClick={() => useReviewStore.getState().toggleTab(agentId, value)}
                >
                  <Icon />
                  <span className="sr-only">
                    {TAB_LABEL[value]} panel{marked && ", uncommitted changes"}
                  </span>
                  {marked && (
                    <span
                      aria-hidden
                      data-testid="rail-dirty"
                      className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-status-input"
                    />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">{TAB_LABEL[value]}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
