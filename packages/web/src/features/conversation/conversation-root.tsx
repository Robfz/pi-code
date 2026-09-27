import { type ReactNode, useEffect, useState } from "react";
import { type ConnectionDeps, ConversationConnection } from "@/store/connection";
import { ConversationStoreProvider } from "@/store/context";
import { createConversationStore } from "@/store/conversation-store";

/**
 * Owns one agent's store and connection for as long as the `/agents/$agentId` subtree is
 * mounted (conversation, tree and diff share it). Key it by `agentId`.
 */
export function ConversationRoot({
  agentId,
  connectionDeps,
  children,
}: {
  agentId: string;
  connectionDeps?: Partial<ConnectionDeps>;
  children: ReactNode;
}) {
  const [store] = useState(() => createConversationStore(agentId));
  const [deps] = useState(() => connectionDeps);
  useEffect(() => {
    const connection = new ConversationConnection(store, deps);
    connection.start();
    return () => connection.stop();
  }, [store, deps]);
  return <ConversationStoreProvider store={store}>{children}</ConversationStoreProvider>;
}
