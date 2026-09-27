import { type AssistantMessage, effectiveStopReason } from "@pi-code/protocol";
import { CircleAlertIcon, SquareIcon } from "lucide-react";
import { memo } from "react";
import { Markdown } from "@/components/markdown";
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

/** Text (Streamdown), thinking (collapsed), tool calls paired with their results. */
export const AssistantMessageView = memo(function AssistantMessageView({
  message,
}: {
  message: AssistantMessage;
}) {
  return (
    <div data-testid="assistant-message" className="flex min-w-0 flex-col gap-2">
      {message.content.map((block, index) => {
        switch (block.type) {
          case "text":
            return block.text.trim() === "" ? null : (
              // biome-ignore lint/suspicious/noArrayIndexKey: content blocks are positional
              <Markdown key={index} text={block.text} />
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
