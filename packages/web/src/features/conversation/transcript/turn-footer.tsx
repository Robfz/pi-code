import { useNavigate } from "@tanstack/react-router";
import { GitCompareIcon } from "lucide-react";
import { Fragment, type ReactNode, useMemo } from "react";
import { CopyButton } from "@/components/copy-button";
import { useReviewStore } from "@/features/review/review-state";
import { formatCost, formatSeconds } from "@/lib/time";
import { useIsDesktop } from "@/lib/use-media-query";
import { useConversation } from "@/store/context";
import { type Turn, type TurnStats, turnStats } from "@/store/turns";
import { useUiPrefs } from "@/store/ui-prefs";

/** "4 files +120 −30": opens the review's Changes tab (the pane on desktop, the page on phone). */
function FilesChip({ files }: { files: NonNullable<TurnStats["files"]> }) {
  const agentId = useConversation((s) => s.agentId);
  const desktop = useIsDesktop();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      data-testid="turn-files"
      title={desktop ? "Open in review pane" : "Open diff"}
      className="inline-flex h-[22px] shrink-0 items-center gap-[5px] rounded-md border px-[7px] text-muted-foreground outline-none transition-colors hover:border-input hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3"
      onClick={() => {
        const review = useReviewStore.getState();
        if (desktop) review.openPane(agentId, "changes");
        else {
          review.setTab(agentId, "changes");
          void navigate({ to: "/agents/$agentId/diff", params: { agentId } });
        }
      }}
    >
      <GitCompareIcon />
      {files.count} {files.count === 1 ? "file" : "files"}
      <span className="inline-flex gap-1">
        <span className="text-diff-add">+{files.additions}</span>
        <span className="text-diff-del">−{files.deletions}</span>
      </span>
    </button>
  );
}

/**
 * The line under a finished turn (`docs/design/09-ui-overhaul.md`, "Turn footer"): duration (not
 * in Compact, whose "Worked" row has it), cost and the files chip, then Copy for the final text.
 * Copy shows on the turn's hover where the pointer can hover, always on touch.
 */
export function TurnFooter({ turn }: { turn: Turn }) {
  const stats = useMemo(() => turnStats(turn), [turn]);
  const compact = useUiPrefs((s) => s.density === "compact");
  const parts: { key: string; node: ReactNode }[] = [];
  if (!compact && stats.durationMs !== undefined) {
    parts.push({ key: "duration", node: <span>{formatSeconds(stats.durationMs)}</span> });
  }
  parts.push({ key: "cost", node: <span>{formatCost(stats.cost)}</span> });
  if (stats.files) parts.push({ key: "files", node: <FilesChip files={stats.files} /> });

  return (
    <div
      data-testid="turn-footer"
      className="mt-3.5 flex min-w-0 items-center gap-[7px] text-xs text-faint-foreground tabular-nums"
    >
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index > 0 && <span aria-hidden>·</span>}
          {part.node}
        </Fragment>
      ))}
      {stats.finalText !== undefined && (
        <CopyButton
          text={stats.finalText}
          label="Copy response"
          className="text-muted-foreground transition-opacity focus-visible:opacity-100 max-lg:ml-auto [@media(hover:hover)]:opacity-0 group-hover/turn:opacity-100"
        />
      )}
    </div>
  );
}
