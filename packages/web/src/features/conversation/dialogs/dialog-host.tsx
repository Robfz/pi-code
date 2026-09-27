import type { PendingDialog } from "@pi-code/protocol";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { errorMessage, isApiRequestError, respondUi } from "@/lib/api";
import { useConversation } from "@/store/context";
import { selectDialogs } from "@/store/selectors";
import { useCountdown } from "./countdown";
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
 * Expired dialogs (countdown at 0) hide locally, since pi sends nothing on timeout.
 */
export function DialogHost() {
  const agentId = useConversation((s) => s.agentId);
  const dialogs = useConversation(selectDialogs);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const dialog = dialogs.find((d) => !dismissed.has(d.request.id));

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => new Set(prev).add(id));
  }, []);

  if (!dialog) return null;
  return (
    <DialogSheet key={dialog.request.id} agentId={agentId} dialog={dialog} onDismiss={dismiss} />
  );
}

function DialogSheet({
  agentId,
  dialog,
  onDismiss,
}: {
  agentId: string;
  dialog: PendingDialog;
  onDismiss(id: string): void;
}) {
  const { request } = dialog;
  const [busy, setBusy] = useState(false);
  const expire = useCallback(() => onDismiss(request.id), [onDismiss, request.id]);
  const seconds = useCountdown(dialog.expiresAt, expire);

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

  const props = { seconds, busy, onAnswer: (a: DialogAnswer) => void answer(a) };
  const editor = request.method === "editor";

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !busy) void answer({ cancelled: true });
      }}
    >
      <SheetContent
        side="bottom"
        data-testid={`dialog-${request.method}`}
        className={
          editor
            ? "h-dvh pb-[env(safe-area-inset-bottom)]"
            : "max-h-[85dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
        }
      >
        {request.method === "select" && <SelectDialogView request={request} {...props} />}
        {request.method === "confirm" && <ConfirmDialogView request={request} {...props} />}
        {request.method === "input" && <InputDialogView request={request} {...props} />}
        {request.method === "editor" && <EditorDialogView request={request} {...props} />}
      </SheetContent>
    </Sheet>
  );
}
