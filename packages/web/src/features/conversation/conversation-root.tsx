import { PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { ProjectPicker } from "@/features/catalog/project-picker";
import { PlaceholderScreen } from "@/routes/placeholder";
import { ConversationStoreProvider, useLiveRegistry } from "@/store/context";

function ConversationClosed() {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <PlaceholderScreen title="Conversation closed">
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <p>This conversation is closed.</p>
        <Button onClick={() => setPickerOpen(true)}>
          <PlusIcon /> New conversation
        </Button>
        <ProjectPicker open={pickerOpen} onOpenChange={setPickerOpen} />
      </div>
    </PlaceholderScreen>
  );
}

/**
 * The `/agents/$agentId` subtree (conversation, tree and diff) around the agent's store from
 * the live registry, marked as the conversation on screen while mounted. Key it by `agentId`.
 * Once the agent is closed, the subtree gives way to "Conversation closed".
 */
export function ConversationRoot({ agentId, children }: { agentId: string; children: ReactNode }) {
  const registry = useLiveRegistry();
  const [store] = useState(() => registry.open(agentId));
  useEffect(() => registry.show(agentId), [registry, agentId]);
  const closed = useStore(store, (s) => s.closed);
  return (
    <ConversationStoreProvider store={store}>
      {closed ? <ConversationClosed /> : children}
    </ConversationStoreProvider>
  );
}
