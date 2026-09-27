/**
 * Client-only UI state of the conversation screen, shared by the header menu, the composer's
 * slash commands, the status bar and the tree screen: which action sheet is open, a draft to
 * put into the composer (after a fork), and which `!!` runs are excluded from the context.
 * Everything is keyed by agent id so state never leaks into another conversation.
 */

import { create } from "zustand";

export type ActionSheet = "fork" | "compact" | "rename" | "model" | "thinking" | "stats";

interface ConversationUi {
  sheet: { agentId: string; kind: ActionSheet } | null;
  draft: { agentId: string; text: string; nonce: number } | null;
  /** `!!` bash run ids (the live `bash` state doesn't carry `excludeFromContext`). */
  excludedBash: Record<string, true>;
  openSheet(agentId: string, kind: ActionSheet): void;
  closeSheet(): void;
  setDraft(agentId: string, text: string): void;
  takeDraft(agentId: string): string | null;
  markBashExcluded(id: string): void;
  reset(): void;
}

let nonce = 0;

export const useConversationUi = create<ConversationUi>()((set, get) => ({
  sheet: null,
  draft: null,
  excludedBash: {},
  openSheet: (agentId, kind) => set({ sheet: { agentId, kind } }),
  closeSheet: () => set({ sheet: null }),
  setDraft: (agentId, text) => set({ draft: { agentId, text, nonce: ++nonce } }),
  takeDraft: (agentId) => {
    const draft = get().draft;
    if (draft === null || draft.agentId !== agentId) return null;
    set({ draft: null });
    return draft.text;
  },
  markBashExcluded: (id) => set((s) => ({ excludedBash: { ...s.excludedBash, [id]: true } })),
  reset: () => set({ sheet: null, draft: null, excludedBash: {} }),
}));
