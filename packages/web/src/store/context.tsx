import { createContext, type ReactNode, useContext } from "react";
import { useStore } from "zustand";
import type { ConversationState, ConversationStore } from "./conversation-store";

const ConversationStoreContext = createContext<ConversationStore | null>(null);

export function ConversationStoreProvider({
  store,
  children,
}: {
  store: ConversationStore;
  children: ReactNode;
}) {
  return (
    <ConversationStoreContext.Provider value={store}>{children}</ConversationStoreContext.Provider>
  );
}

export function useConversationStore(): ConversationStore {
  const store = useContext(ConversationStoreContext);
  if (store === null) throw new Error("useConversation outside ConversationStoreProvider");
  return store;
}

/** Subscribe to a slice of the current conversation (`useConversation(s => s.live.streaming)`). */
export function useConversation<T>(selector: (state: ConversationState) => T): T {
  return useStore(useConversationStore(), selector);
}
