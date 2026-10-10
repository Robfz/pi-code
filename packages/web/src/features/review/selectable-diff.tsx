/**
 * A diff whose lines can be sent to the composer as references (`docs/design/07-code-review.md`,
 * "Selectable diff"). Desktop: a click or drag on line numbers inserts the reference. Phone: a
 * first tap marks the start, a second tap on the same side the range, and `AddToChatBar` inserts
 * it; one pending selection exists across the screen (`line-selection.ts`).
 */

import { type CodeRef, formatCodeRef } from "@pi-code/protocol";
import { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { DiffViewer, type DiffViewerProps, type LineSelection } from "@/components/diff";
import { Button } from "@/components/ui/button";
import { useIsDesktop } from "@/lib/use-media-query";
import { useConversation } from "@/store/context";
import { useDrafts } from "@/store/drafts";
import { type PendingSelection, useLineSelection } from "./line-selection";

export interface SelectableDiffProps
  extends Omit<DiffViewerProps, "onSelectLines" | "selection" | "scrollTo"> {
  /** The reference for selected lines. */
  toReference(selection: LineSelection): CodeRef;
  /** After a reference is inserted. */
  onAdded?(): void;
  /** New-side lines to mark and scroll to; a new `nonce` scrolls again. */
  highlight?: { start: number; end: number; nonce: number };
}

function pendingRange({ side, anchor, end = anchor }: PendingSelection): LineSelection {
  return { side, start: Math.min(anchor, end), end: Math.max(anchor, end) };
}

/** The reference text, or `null` with a toast when its path can't be written. */
function referenceText(ref: CodeRef): string | null {
  const text = formatCodeRef(ref);
  if (text === null) toast.error("Paths containing quotes or line breaks can't be referenced.");
  return text;
}

export function SelectableDiff({
  toReference,
  onAdded,
  highlight,
  ...viewer
}: SelectableDiffProps) {
  const owner = useId();
  const agentId = useConversation((s) => s.agentId);
  const desktop = useIsDesktop();
  const pending = useLineSelection((s) => (s.pending?.owner === owner ? s.pending : null));

  // A new patch can shift its lines.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleared when the patch changes
  useEffect(() => () => useLineSelection.getState().clear(owner), [owner, viewer.patch]);

  const add = (selection: LineSelection) => {
    const text = referenceText(toReference(selection));
    if (text === null) return;
    useDrafts.getState().insertReference(agentId, text);
    onAdded?.();
  };

  const onSelectLines = (selection: LineSelection) => {
    if (desktop) {
      add(selection);
      return;
    }
    const { pending: current, set, clear } = useLineSelection.getState();
    const { side, start, end } = selection;
    const open = current?.owner === owner && current.end === undefined && current.side === side;
    const next: PendingSelection =
      start !== end
        ? { owner, side, anchor: start, end }
        : open
          ? { ...current, end: start }
          : { owner, side, anchor: start };
    if (next.end !== undefined && referenceText(toReference(pendingRange(next))) === null) {
      clear(owner);
      return;
    }
    set(next);
  };

  const marked = highlight
    ? { side: "new" as const, start: highlight.start, end: highlight.end }
    : undefined;
  return (
    <>
      <DiffViewer
        {...viewer}
        onSelectLines={onSelectLines}
        selection={desktop ? marked : pending ? pendingRange(pending) : (marked ?? null)}
        scrollTo={highlight && { line: highlight.start, nonce: highlight.nonce }}
      />
      {pending && (
        <AddToChatBar
          reference={
            pending.end === undefined
              ? undefined
              : formatCodeRef(toReference(pendingRange(pending)))
          }
          onAdd={() => {
            useLineSelection.getState().clear(owner);
            add(pendingRange(pending));
          }}
          onCancel={() => useLineSelection.getState().clear(owner)}
        />
      )}
    </>
  );
}

/** The phone's selection bar, fixed at the bottom of the screen. */
function AddToChatBar({
  reference,
  onAdd,
  onCancel,
}: {
  /** The reference once the range is complete. */
  reference: string | null | undefined;
  onAdd(): void;
  onCancel(): void;
}) {
  return createPortal(
    <div
      role="toolbar"
      aria-label="Line selection"
      className="fixed inset-x-0 bottom-0 z-50 flex items-center gap-2 border-t bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-lg"
    >
      {reference ? (
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-blue-600 dark:text-blue-400">
          {reference}
        </span>
      ) : (
        <span className="min-w-0 flex-1 text-sm text-muted-foreground">Tap the last line</span>
      )}
      <Button variant="outline" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      {reference && (
        <Button size="sm" onClick={onAdd}>
          Add to chat
        </Button>
      )}
    </div>,
    document.body,
  );
}
