import { BrainIcon } from "lucide-react";
import { CollapsibleRow } from "@/components/collapsible-row";
import { formatSeconds } from "@/lib/time";
import { useConversation } from "@/store/context";
import { useRowOpen } from "@/store/ui-prefs";

function lastLine(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.at(-1)?.trim() ?? "";
}

/**
 * A thinking block's row: "Thinking" with its latest line while it streams, then "Thought for
 * 12s" (from the streaming block's `startedAt` / `endedAt`, else the live state's `thinkingMs`
 * under `durationKey`), or "Thought" when the duration is unknown. Open by default in Detailed.
 */
export function Thinking({
  text,
  live = false,
  redacted = false,
  startedAt,
  endedAt,
  durationKey,
}: {
  text: string;
  live?: boolean;
  redacted?: boolean;
  startedAt?: number;
  endedAt?: number;
  /** A committed block's `thinkingMs` key (`thinkingKey`). */
  durationKey?: string;
}) {
  const recorded = useConversation((s) =>
    durationKey === undefined ? undefined : s.live.thinkingMs[durationKey],
  );
  const [open, setOpen] = useRowOpen((density) => density === "detailed");
  const durationMs =
    startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : recorded;

  if (redacted) {
    return (
      <CollapsibleRow
        data-testid="thinking"
        icon={<BrainIcon />}
        label={<span className="font-medium text-foreground">Thought (redacted)</span>}
      />
    );
  }
  if (!live && text.trim() === "") return null;

  const preview = live ? lastLine(text) : "";
  return (
    <CollapsibleRow
      data-testid="thinking"
      open={open}
      onOpenChange={setOpen}
      icon={<BrainIcon />}
      label={
        live ? (
          <span className="shimmer font-medium">Thinking</span>
        ) : (
          <>
            <span className="font-medium text-foreground">Thought</span>
            {durationMs !== undefined && (
              <span className="text-muted-foreground tabular-nums">
                for {formatSeconds(durationMs)}
              </span>
            )}
          </>
        )
      }
      collapsed={
        preview ? (
          <div
            data-testid="thinking-preview"
            className="-mt-0.5 mb-1 truncate pl-[22px] text-sm text-faint-foreground"
          >
            {preview}
          </div>
        ) : undefined
      }
      bodyClassName="lg:pl-0"
    >
      <div className="mt-0.5 mb-2.5 ml-1.5 border-l border-input py-0.5 pl-[15px] text-sm leading-[1.6] whitespace-pre-wrap break-words text-muted-foreground">
        {text.trim()}
      </div>
    </CollapsibleRow>
  );
}
