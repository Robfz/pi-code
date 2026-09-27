import type { ImageContent, TextContent } from "@pi-code/protocol";
import { PuzzleIcon } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { contentText } from "@/lib/content";
import { getCustomMessageRenderer } from "./custom-message-registry";

/** Extension message with `display: true`: markdown of `content` in a small card. */
export function CustomMessageView({
  customType,
  content,
  details,
}: {
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: unknown;
}) {
  const Card = getCustomMessageRenderer(customType);
  if (Card) {
    return (
      <div data-testid="custom-message" data-custom-type={customType}>
        <Card customType={customType} content={content} details={details} />
      </div>
    );
  }
  return (
    <div
      data-testid="custom-message"
      className="rounded-lg border border-dashed bg-card/30 px-3 py-2"
    >
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <PuzzleIcon className="size-3.5" />
        <span className="font-mono">{customType}</span>
      </div>
      <Markdown text={contentText(content)} />
    </div>
  );
}
