import { type AssistantMessage, effectiveStopReason, findCodeRefs } from "@pi-code/protocol";
import { CircleAlertIcon, SquareIcon } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { useOpenReference } from "@/features/review/open-reference";

/** Error / stopped / truncated footer of a finished assistant message. */
export function StopReasonNotice({
  message,
}: {
  message: Pick<AssistantMessage, "stopReason" | "errorMessage">;
}) {
  const reason = effectiveStopReason(message);
  if (reason === "error") {
    return (
      <div
        role="alert"
        data-testid="assistant-error"
        className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
        <span className="break-words">{message.errorMessage ?? "The model returned an error"}</span>
      </div>
    );
  }
  if (reason === "aborted") {
    return (
      <div
        data-testid="assistant-aborted"
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <SquareIcon className="size-3" /> Stopped
      </div>
    );
  }
  if (reason === "length") {
    return <div className="text-xs text-muted-foreground">Output truncated (token limit)</div>;
  }
  return null;
}

/**
 * Assistant text (Streamdown). Line references in it are clickable (`span[data-code-ref]`,
 * handled here by delegation), streaming or not: switching `codeRefs` when the text finishes
 * would parse every block of it again.
 */
export function AssistantText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const openReference = useOpenReference();
  /** Opens the reference `target` is in; `false` when it isn't in one. */
  const openAt = (target: EventTarget): boolean => {
    const element = (target as Element).closest("[data-code-ref]");
    const ref = element && findCodeRefs(element.textContent ?? "")[0];
    if (!ref) return false;
    openReference(ref);
    return true;
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: delegates for the role="button" references inside
    <div
      data-testid="assistant-text"
      className="min-w-0"
      onClick={(event) => openAt(event.target)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && openAt(event.target)) event.preventDefault();
      }}
    >
      <Markdown text={text} streaming={streaming} codeRefs />
    </div>
  );
}
