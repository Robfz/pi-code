import { useRef } from "react";
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
import { StatusBar } from "./status-bar";
import { LiveSection } from "./transcript/live-section";
import { Transcript } from "./transcript/transcript";
import { useStickToBottom } from "./use-stick-to-bottom";

/** `/agents/$agentId`: header, transcript + live part, composer area, dialogs. */
export function ConversationScreen() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useStickToBottom(scrollRef, contentRef);
  const exited = useConversation((s) => s.agent.status === "exited");
  // Full content width on desktop; capped below.
  const column = cn("flex w-full flex-col", !useIsDesktop() && "mx-auto max-w-3xl");

  return (
    <div className="flex h-dvh flex-col">
      <ConversationHeader />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div
          ref={contentRef}
          data-testid="transcript-column"
          className={cn(column, "gap-4 px-3 py-4")}
        >
          <Transcript />
          <LiveSection />
          <AgentStatePanel />
        </div>
      </div>
      <div
        data-testid="composer-column"
        className={cn(column, "gap-2 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]")}
      >
        <QueueDisplay />
        <Widgets placement="aboveEditor" />
        {!exited && <Composer />}
        <Widgets placement="belowEditor" />
        <StatusBar />
      </div>
      <DialogHost />
      <TrustSheet />
      <ActionSheets />
      <NoticeToaster />
      <DocumentTitle />
    </div>
  );
}
