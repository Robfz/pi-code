/**
 * Client-only UI state of the conversation screen, shared by the header menu, the composer's
 * slash commands, the status bar and the tree screen: which action sheet is open.
 * Keyed by agent id so state never leaks into another conversation. Composer drafts live in
 * `store/drafts.ts`.
 */

import { create } from "zustand";

export type ActionSheet = "fork" | "compact" | "rename" | "model" | "thinking" | "stats";

interface ConversationUi {
  sheet: { agentId: string; kind: ActionSheet } | null;
  openSheet(agentId: string, kind: ActionSheet): void;
  closeSheet(): void;
  reset(): void;
}

export const useConversationUi = create<ConversationUi>()((set) => ({
  sheet: null,
  openSheet: (agentId, kind) => set({ sheet: { agentId, kind } }),
  closeSheet: () => set({ sheet: null }),
  reset: () => set({ sheet: null }),
}));
