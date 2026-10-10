/**
 * Composer drafts, one per conversation, in memory for the tab's lifetime
 * (`docs/design/07-code-review.md`, "Draft store"). The composer's only text state, so a draft
 * survives navigating away from the conversation and back.
 */

import { create } from "zustand";
import type { Attachment } from "@/features/conversation/attachments";

export interface DraftSelection {
  start: number;
  end: number;
}

export interface Draft {
  text: string;
  /** The textarea's selection, updated on input, select and blur. */
  selection: DraftSelection;
  attachments: Attachment[];
  /** Bumped by changes made outside the composer; the composer then focuses and applies `selection`. */
  external: number;
}

interface Drafts {
  drafts: Record<string, Draft>;
  /** Typing. */
  edit(agentId: string, text: string, selection: DraftSelection): void;
  setAttachments(agentId: string, attachments: Attachment[]): void;
  /** Fork, share, `set_editor_text`, Stop & edit: the caret goes to the end. */
  replace(agentId: string, text: string): void;
  /** Replace the selection with `ref`, spaced from its neighbours; the caret goes after it. */
  insertReference(agentId: string, ref: string): void;
  /** On send. */
  clear(agentId: string): void;
}

export const EMPTY_DRAFT: Draft = {
  text: "",
  selection: { start: 0, end: 0 },
  attachments: [],
  external: 0,
};

const caretAt = (offset: number): DraftSelection => ({ start: offset, end: offset });

export const useDrafts = create<Drafts>()((set) => {
  const update = (agentId: string, change: (draft: Draft) => Partial<Draft>) =>
    set((state) => {
      const draft = state.drafts[agentId] ?? EMPTY_DRAFT;
      return { drafts: { ...state.drafts, [agentId]: { ...draft, ...change(draft) } } };
    });

  return {
    drafts: {},
    edit: (agentId, text, selection) => update(agentId, () => ({ text, selection })),
    setAttachments: (agentId, attachments) => update(agentId, () => ({ attachments })),
    replace: (agentId, text) =>
      update(agentId, (draft) => ({
        text,
        selection: caretAt(text.length),
        external: draft.external + 1,
      })),
    insertReference: (agentId, ref) =>
      update(agentId, (draft) => {
        const { text } = draft;
        const start = Math.min(draft.selection.start, text.length);
        const end = Math.min(Math.max(draft.selection.end, start), text.length);
        const before = text.slice(0, start);
        const after = text.slice(end);
        const inserted = `${before === "" || /\s$/.test(before) ? "" : " "}${ref}${/^\s/.test(after) ? "" : " "}`;
        return {
          text: before + inserted + after,
          selection: caretAt(start + inserted.length),
          external: draft.external + 1,
        };
      }),
    clear: (agentId) =>
      update(agentId, () => ({ text: "", selection: caretAt(0), attachments: [] })),
  };
});
