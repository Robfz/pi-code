import type { PendingDialog } from "@pi-code/protocol";
import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { errorMessage, isApiRequestError, respondUi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useConversation } from "@/store/context";
import { selectDialogs } from "@/store/selectors";
import {
  ConfirmDialogView,
  type DialogAnswer,
  EditorDialogView,
  InputDialogView,
  SelectDialogView,
} from "./dialog-views";

/**
 * Pending extension dialogs as bottom sheets, one at a time in arrival order. Answers go to
 * `POST /ui-responses`; the dialog hides right away and `ui_resolved` removes it from the store.
 * A dialog whose countdown reaches 0 stays until the server's `ui_resolved` (the server resolves
 * timed-out dialogs itself; this device's clock may be skewed).
 *
 * Cancel, the sheet's × and Escape answer `cancelled`; tapping outside does nothing, and a
 * dialog left unanswered stays pending (it's in the store, so it shows again on return).
 * With `container` (the conversation column on desktop) the sheet is non-modal and scoped to
 * it, overlay included, so the rest of the page (the sidebar) stays usable; `null` (the container
 * isn't mounted yet) shows nothing.
 */
export function DialogHost({ container }: { container?: HTMLElement | null }) {
  const agentId = useConversation((s) => s.agentId);
  const dialogs = useConversation(selectDialogs);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const dialog = dialogs.find((d) => !dismissed.has(d.request.id));

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => new Set(prev).add(id));
  }, []);

  if (!dialog || container === null) return null;
  return (
    <DialogSheet
      key={dialog.request.id}
      agentId={agentId}
      dialog={dialog}
      container={container}
      onDismiss={dismiss}
    />
  );
}

function DialogSheet({
  agentId,
  dialog,
  container,
  onDismiss,
}: {
  agentId: string;
  dialog: PendingDialog;
  container: HTMLElement | undefined;
  onDismiss(id: string): void;
}) {
  const { request } = dialog;
  const [busy, setBusy] = useState(false);

  async function answer(body: DialogAnswer) {
    setBusy(true);
    try {
      await respondUi(agentId, { id: request.id, ...body } as Parameters<typeof respondUi>[1]);
      onDismiss(request.id);
    } catch (error) {
      if (isApiRequestError(error, "dialog_not_found")) {
        toast.info("This dialog is no longer pending");
        onDismiss(request.id);
      } else {
        toast.error(errorMessage(error));
        setBusy(false);
      }
    }
  }

  const props = {
    expiresAt: dialog.expiresAt,
    busy,
    onAnswer: (a: DialogAnswer) => void answer(a),
  };
  const editor = request.method === "editor";

  return (
    <Sheet
      open
      modal={container === undefined}
      onOpenChange={(open) => {
        if (!open && !busy) void answer({ cancelled: true });
      }}
    >
      {container &&
        createPortal(
          <div
            data-slot="sheet-overlay"
            className="absolute inset-0 z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs"
          />,
          container,
        )}
      <SheetContent
        side="bottom"
        container={container}
        data-testid={`dialog-${request.method}`}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          // Scoped: Escape typed elsewhere on the page (e.g. the sidebar search) isn't for it.
          const target = event.target;
          if (
            container &&
            target instanceof Node &&
            target !== document.body &&
            !container.contains(target)
          )
            event.preventDefault();
        }}
        className={cn(
          "pb-[env(safe-area-inset-bottom)]",
          container && "absolute",
          editor ? (container ? "h-full" : "h-dvh") : "max-h-[85dvh] rounded-t-2xl",
        )}
      >
        {request.method === "select" && <SelectDialogView request={request} {...props} />}
        {request.method === "confirm" && <ConfirmDialogView request={request} {...props} />}
        {request.method === "input" && <InputDialogView request={request} {...props} />}
        {request.method === "editor" && <EditorDialogView request={request} {...props} />}
      </SheetContent>
    </Sheet>
  );
}
