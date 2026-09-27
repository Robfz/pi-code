/**
 * Client-only UI state of the conversation screen, shared by the header menu, the composer's
 * slash commands, the status bar and the tree screen: which action sheet is open, and a draft
 * to put into the composer (after a fork).
 * Everything is keyed by agent id so state never leaks into another conversation.
 */

import { create } from "zustand";

export type ActionSheet = "fork" | "compact" | "rename" | "model" | "thinking" | "stats";

interface ConversationUi {
  sheet: { agentId: string; kind: ActionSheet } | null;
  draft: { agentId: string; text: string; nonce: number } | null;
  openSheet(agentId: string, kind: ActionSheet): void;
  closeSheet(): void;
  setDraft(agentId: string, text: string): void;
  takeDraft(agentId: string): string | null;
  reset(): void;
}

let nonce = 0;

export const useConversationUi = create<ConversationUi>()((set, get) => ({
  sheet: null,
  draft: null,
  openSheet: (agentId, kind) => set({ sheet: { agentId, kind } }),
  closeSheet: () => set({ sheet: null }),
  setDraft: (agentId, text) => set({ draft: { agentId, text, nonce: ++nonce } }),
  takeDraft: (agentId) => {
    const draft = get().draft;
    if (draft === null || draft.agentId !== agentId) return null;
    set({ draft: null });
    return draft.text;
  },
  reset: () => set({ sheet: null, draft: null }),
}));
