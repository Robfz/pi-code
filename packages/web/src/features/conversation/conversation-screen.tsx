import { useRef, useState } from "react";
import { ReviewPane } from "@/features/review/review-pane";
import { useReviewStore } from "@/features/review/review-state";
import { useIsDesktop } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { useConversation } from "@/store/context";
import { ActionSheets } from "./action-sheets";
import { AgentStatePanel, TrustSheet } from "./agent-state";
import { Composer } from "./composer";
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
 * `/agents/$agentId`: header, transcript + live part, composer area, dialogs; on desktop, the
 * review pane beside them when open.
 */
export function ConversationScreen() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useStickToBottom(scrollRef, contentRef);
  const exited = useConversation((s) => s.agent.status === "exited");
  const desktop = useIsDesktop();
  const agentId = useConversation((s) => s.agentId);
  const pane = useReviewStore((s) => s.reviews[agentId]?.paneOpen ?? false) && desktop;
  // Where desktop scopes the dialog and trust sheets, clear of the sidebar.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  // What such a sheet's overlay covers is inert while it's open: focus skips to the sidebar.
  const { covered, cover } = useScopedCover();
  const inert = covered || undefined;
  // Full content width on desktop; capped below.
  const column = cn("flex w-full flex-col", !desktop && "mx-auto max-w-3xl");
  const padding = pane ? "lg:px-6" : "lg:px-32";

  return (
    <div className="flex h-dvh">
      <div ref={setRoot} className="relative flex h-dvh min-w-0 flex-1 flex-col">
        <ConversationHeader inert={inert} paneOpen={pane} className={padding} />
        <div
          ref={scrollRef}
          inert={inert}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <div
            ref={contentRef}
            data-testid="transcript-column"
            className={cn(column, "gap-4 px-3 py-4 lg:py-8", padding)}
          >
            <Transcript />
            <LiveSection />
            <AgentStatePanel />
          </div>
        </div>
        <div
          data-testid="composer-column"
          inert={inert}
          className={cn(
            column,
            "gap-2 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]",
            padding,
          )}
        >
          <QueueDisplay />
          <Widgets placement="aboveEditor" />
          {!exited && <Composer />}
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
      {pane && <ReviewPane agentId={agentId} />}
    </div>
  );
}
