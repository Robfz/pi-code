import type { AgentInfo } from "@pi-code/protocol";
import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { ConversationState, ConversationStore } from "./conversation-store";
import type { LiveOverview, LiveRegistry } from "./live-registry";

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

const noSubscription = () => () => {};

/** The current conversation's cwd; "" outside a conversation (a row rendered on its own). */
export function useConversationCwd(): string {
  const store = useContext(ConversationStoreContext);
  return useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    () => store?.getState().agent.cwd ?? "",
  );
}

const LiveRegistryContext = createContext<LiveRegistry | null>(null);

export function LiveRegistryProvider({
  registry,
  children,
}: {
  registry: LiveRegistry;
  children: ReactNode;
}) {
  return <LiveRegistryContext.Provider value={registry}>{children}</LiveRegistryContext.Provider>;
}

export function useLiveRegistry(): LiveRegistry {
  const registry = useContext(LiveRegistryContext);
  if (registry === null) throw new Error("useLiveRegistry outside LiveRegistryProvider");
  return registry;
}

/** Subscribe to a slice of the tab's live overview (`useLive(s => s.agents)`). */
export function useLive<T>(selector: (state: LiveOverview) => T): T {
  return useStore(useLiveRegistry().live, selector);
}

/** The live agents, or `undefined` until the stream's first baseline. */
export function useLiveAgents(): AgentInfo[] | undefined {
  return useLive(useShallow((s) => (s.loaded ? Object.values(s.agents) : undefined)));
}
