import { memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

/**
 * Markdown via Streamdown; `streaming` enables incomplete-markdown handling for live text.
 * Single newlines inside a paragraph render as line breaks (`pre-line`), like pi's TUI.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  return (
    <Streamdown
      className={cn(
        "markdown min-w-0 break-words text-sm leading-relaxed [&_p]:whitespace-pre-line",
        className,
      )}
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      parseIncompleteMarkdown={streaming}
    >
      {text}
    </Streamdown>
  );
});
