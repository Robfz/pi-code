import { useRef } from "react";
import { useConversation } from "@/store/context";
import { AgentStatePanel, TrustSheet } from "./agent-state";
import { Composer } from "./composer";
import { DialogHost } from "./dialogs/dialog-host";
import { DocumentTitle, NoticeToaster, StatusChips, Widgets } from "./extension-ui";
import { ConversationHeader } from "./header";
import { QueueDisplay } from "./queue-display";
import { LiveSection } from "./transcript/live-section";
import { Transcript } from "./transcript/transcript";
import { useStickToBottom } from "./use-stick-to-bottom";

/** `/agents/$agentId`: header, transcript + live part, composer area, dialogs. */
export function ConversationScreen() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useStickToBottom(scrollRef, contentRef);
  const exited = useConversation((s) => s.agent.status === "exited");

  return (
    <div className="flex h-dvh flex-col">
      <ConversationHeader />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 py-4">
          <Transcript />
          <LiveSection />
          <AgentStatePanel />
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <QueueDisplay />
        <Widgets placement="aboveEditor" />
        {!exited && <Composer />}
        <Widgets placement="belowEditor" />
        <StatusChips />
      </div>
      <DialogHost />
      <TrustSheet />
      <NoticeToaster />
      <DocumentTitle />
    </div>
  );
}
