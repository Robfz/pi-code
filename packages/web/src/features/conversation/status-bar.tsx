import { GitBranchIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { baseName } from "@/lib/content";
import { formatCost } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useConversation } from "@/store/context";
import { selectSessionName } from "@/store/selectors";
import { useOpenSheet } from "./action-sheets";
import { StatusChips } from "./extension-ui";

export const CONTEXT_CELLS = 5;

/** Filled cells of the context bar for a usage percentage (null → unknown, 0 cells). */
export function contextCells(percent: number | null | undefined): number {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(CONTEXT_CELLS, Math.ceil(percent / (100 / CONTEXT_CELLS))));
}

function ContextBar({ percent }: { percent: number | null | undefined }) {
  const filled = contextCells(percent);
  const known = percent !== null && percent !== undefined;
  const tone =
    known && percent >= 80
      ? "bg-destructive"
      : known && percent >= 60
        ? "bg-amber-500"
        : "bg-foreground/70";
  return (
    <span
      data-testid="context-bar"
      data-filled={filled}
      className="flex items-center gap-0.5"
      title={known ? `Context ${Math.round(percent)}%` : "Context usage unknown"}
    >
      {Array.from({ length: CONTEXT_CELLS }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed cells
          key={i}
          data-cell={i < filled ? "filled" : "empty"}
          className={cn("h-2.5 w-1.5 rounded-[2px]", i < filled ? tone : "bg-muted-foreground/25")}
        />
      ))}
      <span className="ml-1 tabular-nums">{known ? `${Math.round(percent)}%` : "?"}</span>
    </span>
  );
}

/** Leading run indicator: running / compacting / retrying n/m. */
export function RunIndicator() {
  const run = useConversation((s) => s.live.run);
  const compacting = useConversation((s) => s.state?.isCompacting === true);
  const streaming = useConversation((s) => s.state?.isStreaming === true);
  if (run.retry) {
    return (
      <span
        data-testid="run-indicator"
        className="flex items-center gap-1 text-amber-600 dark:text-amber-400"
      >
        <RefreshCwIcon className="size-3 animate-spin" />
        retrying {run.retry.attempt}/{run.retry.maxAttempts}
      </span>
    );
  }
  if (run.compaction || compacting) {
    return (
      <span data-testid="run-indicator" className="flex items-center gap-1 text-foreground">
        <LoaderIcon className="size-3 animate-spin" /> compacting
      </span>
    );
  }
  if (run.active || streaming) {
    return (
      <span data-testid="run-indicator" className="flex items-center gap-1 text-foreground">
        <LoaderIcon className="size-3 animate-spin" /> running
      </span>
    );
  }
  return null;
}

const itemButton =
  "inline-flex min-w-0 items-center gap-1 rounded px-0.5 hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none";

/**
 * Mirrors the TUI status bar: folder · branch + dirty dot · context bar · session name ·
 * model + thinking level · cost, then extension `setStatus` chips. Model, thinking and
 * context/cost open their pickers / the stats sheet.
 */
export function StatusBar() {
  const ready = useConversation((s) => s.hydrated && s.agent.status === "ready");
  const cwd = useConversation((s) => s.agent.cwd);
  const git = useConversation((s) => s.gitStatus);
  const percent = useConversation((s) => s.stats?.contextUsage?.percent);
  const cost = useConversation((s) => s.stats?.cost);
  const name = useConversation(selectSessionName);
  const modelId = useConversation((s) => s.state?.model?.id);
  const reasoning = useConversation((s) => s.state?.model?.reasoning === true);
  const thinking = useConversation((s) => s.state?.thinkingLevel);
  const openSheet = useOpenSheet();

  return (
    <div className="flex flex-col gap-1">
      <div
        data-testid="status-bar"
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground"
      >
        <RunIndicator />
        {cwd !== "" && (
          <span data-testid="status-folder" className="max-w-[40%] truncate" title={cwd}>
            {baseName(cwd)}
          </span>
        )}
        {git?.branch && (
          <span data-testid="status-branch" className="flex min-w-0 items-center gap-1">
            <GitBranchIcon className="size-3 shrink-0" />
            <span className="max-w-32 truncate">{git.branch}</span>
            {git.dirty && (
              <span
                data-testid="status-dirty"
                role="img"
                aria-label="uncommitted changes"
                className="size-1.5 rounded-full bg-amber-500"
              />
            )}
          </span>
        )}
        <button
          type="button"
          className={itemButton}
          aria-label="Session stats"
          disabled={!ready}
          onClick={() => openSheet("stats")}
        >
          <ContextBar percent={percent} />
        </button>
        {name && (
          <span data-testid="status-name" className="max-w-40 truncate italic">
            {name}
          </span>
        )}
        {modelId && (
          <button
            type="button"
            className={cn(itemButton, "font-mono")}
            aria-label={`Model: ${modelId}`}
            disabled={!ready}
            onClick={() => openSheet("model")}
          >
            <span className="max-w-44 truncate">{modelId}</span>
          </button>
        )}
        {thinking && (reasoning || thinking !== "off") && (
          <button
            type="button"
            className={itemButton}
            aria-label={`Thinking: ${thinking}`}
            disabled={!ready}
            onClick={() => openSheet("thinking")}
          >
            {thinking}
          </button>
        )}
        {cost !== undefined && (
          <button
            type="button"
            className={cn(itemButton, "tabular-nums")}
            aria-label={`Cost ${formatCost(cost)}`}
            disabled={!ready}
            onClick={() => openSheet("stats")}
          >
            {formatCost(cost)}
          </button>
        )}
      </div>
      <StatusChips />
    </div>
  );
}
