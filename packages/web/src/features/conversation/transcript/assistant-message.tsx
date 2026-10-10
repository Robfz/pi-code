import { type AssistantMessage, effectiveStopReason, findCodeRefs } from "@pi-code/protocol";
import { CircleAlertIcon, SquareIcon } from "lucide-react";
import { memo } from "react";
import { Markdown } from "@/components/markdown";
import { useOpenReference } from "@/features/review/open-reference";
import { Thinking } from "./thinking";
import { ToolCallSlot } from "./tool-call-slot";

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
 * Text (Streamdown), thinking (collapsed), tool calls paired with their results. Line references
 * in text blocks are clickable (`span[data-code-ref]`, handled here by delegation).
 */
export const AssistantMessageView = memo(function AssistantMessageView({
  message,
}: {
  message: AssistantMessage;
}) {
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
      data-testid="assistant-message"
      className="flex min-w-0 flex-col gap-2"
      onClick={(event) => openAt(event.target)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && openAt(event.target)) event.preventDefault();
      }}
    >
      {message.content.map((block, index) => {
        switch (block.type) {
          case "text":
            return block.text.trim() === "" ? null : (
              // biome-ignore lint/suspicious/noArrayIndexKey: content blocks are positional
              <Markdown key={index} text={block.text} codeRefs />
            );
          case "thinking":
            return block.redacted ? null : (
              // biome-ignore lint/suspicious/noArrayIndexKey: content blocks are positional
              <Thinking key={index} text={block.thinking} />
            );
          case "toolCall":
            return (
              <ToolCallSlot
                key={block.id}
                toolCallId={block.id}
                toolName={block.name}
                args={block.arguments}
              />
            );
          default:
            return null;
        }
      })}
      <StopReasonNotice message={message} />
    </div>
  );
});
