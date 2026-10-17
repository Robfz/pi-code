import { useLayoutEffect, useRef, useState } from "react";
import { ReviewPane } from "@/features/review/review-pane";
import { ReviewRail } from "@/features/review/review-rail";
import { useReviewStore } from "@/features/review/review-state";
import { useIsDesktop } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { useConversation } from "@/store/context";
import { selectActiveBranch } from "@/store/selectors";
import { ActionSheets } from "./action-sheets";
import { AgentStatePanel, TrustSheet } from "./agent-state";
import { Composer } from "./composer";
import { ConversationOutline } from "./conversation-outline";
import { DialogHost } from "./dialogs/dialog-host";
import { DocumentTitle, NoticeToaster, Widgets } from "./extension-ui";
import { ConversationHeader } from "./header";
import { QueueDisplay } from "./queue-display";
import { ScopedCoverProvider, useScopedCover } from "./scoped-overlay";
import { StatusBar } from "./status-bar";
import { LiveSection } from "./transcript/live-section";
import { Transcript } from "./transcript/transcript";
import { useStickToBottom } from "./use-stick-to-bottom";

/**
 * Calls `onSwitch` after the leaf moves off the branch it was on (the tree's Go here, from any
 * client), rather than along it. The screen stays mounted through such a move.
 */
function useBranchSwitch(onSwitch: () => void) {
  const leafId = useConversation((s) => s.transcript.leafId);
  const branch = useConversation(selectActiveBranch);
  const previous = useRef(leafId);
  useLayoutEffect(() => {
    const left = previous.current;
    previous.current = leafId;
    if (left !== null && left !== leafId && !branch.some((entry) => entry.id === left)) {
      onSwitch();
    }
  }, [leafId, branch, onSwitch]);
}

/**
 * `/agents/$agentId`: header, transcript + live part, composer area, dialogs; on desktop, the
 * conversation outline in the transcript's right margin when it fits, the review pane beside
 * them when open and the rail at the right edge.
 */
export function ConversationScreen() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const follow = useStickToBottom(scrollRef, contentRef);
  // Another branch's transcript: start at its end, following it.
  useBranchSwitch(follow.toBottom);
  const exited = useConversation((s) => s.agent.status === "exited");
  const desktop = useIsDesktop();
  const agentId = useConversation((s) => s.agentId);
  const pane = useReviewStore((s) => s.reviews[agentId]?.paneOpen ?? false) && desktop;
  // Where desktop scopes the dialog and trust sheets, clear of the sidebar.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  // What such a sheet's overlay covers is inert while it's open: focus skips to the sidebar.
  const { covered, cover } = useScopedCover();
  const inert = covered || undefined;
  // One centred column for the transcript and the composer area; beside the review pane it
  // narrows to the space left.
  const column = "mx-auto flex w-full max-w-[46rem] flex-col px-4 lg:px-6";

  return (
    // Under Window Controls Overlay, a header's distance from the window's right edge: the rail's
    // width, plus the pane's beside it, half of what the sidebar and the rail leave.
    <div className={cn("flex h-dvh", desktop && "[--titlebar-right:var(--rail-width)]")}>
      <div
        ref={setRoot}
        className={cn(
          "relative flex h-dvh min-w-0 flex-1 flex-col",
          pane &&
            "[--titlebar-right:calc((100vw-var(--titlebar-left,0px)-var(--rail-width))/2+var(--rail-width))]",
        )}
      >
        <ConversationHeader inert={inert} />
        <div
          ref={scrollRef}
          data-testid="transcript-scroll"
          inert={inert}
          className={cn(
            "min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable_both-edges]",
            // A size container for the outline's margin and height. Desktop only: containment
            // makes it the containing block of fixed descendants (the phone's selection bar).
            desktop && "@container-size",
          )}
        >
          <div
            ref={contentRef}
            data-testid="transcript-column"
            className={cn(column, "relative gap-4 py-4 lg:py-8")}
          >
            {desktop && <ConversationOutline scrollRef={scrollRef} scrollTo={follow.scrollTo} />}
            <Transcript />
            <LiveSection />
            <AgentStatePanel />
          </div>
        </div>
        <div
          data-testid="composer-column"
          inert={inert}
          className={cn(column, "gap-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]")}
        >
          <QueueDisplay />
          <Widgets placement="aboveEditor" />
          {!exited && <Composer onSubmit={follow.toBottom} />}
          <Widgets placement="belowEditor" />
          <StatusBar />
        </div>
        <ScopedCoverProvider value={cover}>
          <DialogHost container={desktop ? root : undefined} />
          <TrustSheet container={desktop ? root : undefined} />
        </ScopedCoverProvider>
        <ActionSheets />
        <NoticeToaster />
        <DocumentTitle />
      </div>
      {pane && (
        // Roughly where the pane starts: mid-window, off by half the sidebar's width less the
        // rail's. Close enough: it only matters for window controls on the left, which never
        // reach that far.
        <div className="contents [--titlebar-left:50vw]">
          <ReviewPane agentId={agentId} />
        </div>
      )}
      {desktop && <ReviewRail agentId={agentId} />}
    </div>
  );
}
