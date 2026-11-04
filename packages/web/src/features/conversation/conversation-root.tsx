import { LoaderIcon, MessageSquareOffIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useStore } from "zustand";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { agentLayout, agentSession } from "@/features/catalog/listing-groups";
import { ProjectPicker } from "@/features/catalog/project-picker";
import { useOpenAgent } from "@/features/catalog/use-open-agent";
import { pollPr } from "@/lib/api";
import { PlaceholderScreen } from "@/routes/placeholder";
import {
  ConversationStoreProvider,
  useConversation,
  useLive,
  useLiveRegistry,
} from "@/store/context";

/**
 * Offers Reopen when the agent's session is still in the catalog with its folder on disk (an
 * agent never seen, or closed before its first message, has none), and New conversation.
 */
function ConversationClosed() {
  const [pickerOpen, setPickerOpen] = useState(false);
  const open = useOpenAgent();
  const sessionFile = useConversation((s) => s.agent.sessionFile);
  const reopenable = useLive((s) => {
    const session = s.sessions.find((x) => x.file === sessionFile);
    return session !== undefined && !session.missing && !session.layout?.missing;
  });
  return (
    <PlaceholderScreen title="Conversation closed" centered>
      <EmptyState
        icon={<MessageSquareOffIcon />}
        title="This conversation is no longer running"
        description="It was stopped elsewhere, closed after being idle, or its worktree was removed."
        action={
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {reopenable && sessionFile !== undefined && (
              <Button disabled={open.isPending} onClick={() => open.mutate({ sessionFile })}>
                {open.isPending ? <LoaderIcon className="animate-spin" /> : <RotateCcwIcon />}
                Reopen
              </Button>
            )}
            <Button
              variant={reopenable ? "outline" : "default"}
              onClick={() => setPickerOpen(true)}
            >
              <PlusIcon /> New conversation
            </Button>
          </div>
        }
      />
      <ProjectPicker open={pickerOpen} onOpenChange={setPickerOpen} />
    </PlaceholderScreen>
  );
}

/**
 * The `/agents/$agentId` subtree (conversation, tree and diff) around the agent's store from
 * the live registry, marked as the conversation on screen (acked, not evicted) while mounted.
 * Key it by `agentId`.
 * Opening it uncollapses its sidebar groups, whatever led here, and checks an attached PR for new
 * pushes. Once the agent is closed, the subtree gives way to "Conversation closed".
 */
export function ConversationRoot({ agentId, children }: { agentId: string; children: ReactNode }) {
  const registry = useLiveRegistry();
  const [store] = useState(() => registry.open(agentId));
  useEffect(() => registry.show(agentId), [registry, agentId]);
  const cwd = useLive((s) => s.agents[agentId]?.cwd);
  const repo = useLive((s) => {
    const agent = s.agents[agentId];
    return agent && agentLayout(agent, agentSession(agent, s.sessions))?.repo;
  });
  // Not rerun when the collapsed set changes, so its groups can be collapsed again while open.
  useEffect(() => {
    if (cwd !== undefined) registry.expand(repo === undefined ? [cwd] : [cwd, repo]);
  }, [registry, cwd, repo]);
  const sessionFile = useStore(store, (s) => s.agent.sessionFile);
  const attached = useLive((s) => sessionFile !== undefined && s.prs[sessionFile] !== undefined);
  useEffect(() => {
    if (attached) pollPr(agentId).catch(() => {});
  }, [agentId, attached]);
  const closed = useStore(store, (s) => s.closed);
  return (
    <ConversationStoreProvider store={store}>
      {closed ? <ConversationClosed /> : children}
    </ConversationStoreProvider>
  );
}
