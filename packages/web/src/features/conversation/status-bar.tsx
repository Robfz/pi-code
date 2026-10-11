import { GitBranchIcon, LoaderIcon } from "lucide-react";
import { baseName } from "@/lib/content";
import { formatCost } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useConversation } from "@/store/context";
import { selectSessionName, selectSubagentSpend } from "@/store/selectors";
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
      ? "bg-status-error"
      : known && percent >= 60
        ? "bg-status-input"
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

/** "Working" while the run is active, compacting or retrying. */
export function RunIndicator() {
  const working = useConversation(
    (s) =>
      s.live.run.active ||
      s.live.run.retry !== undefined ||
      s.live.run.compaction !== undefined ||
      s.state?.isCompacting === true ||
      s.state?.isStreaming === true,
  );
  if (!working) return null;
  return (
    <span data-testid="run-indicator" className="flex items-center gap-1 text-muted-foreground">
      <LoaderIcon aria-hidden className="size-3 animate-spin" /> Working
    </span>
  );
}

const itemButton =
  "inline-flex min-w-0 items-center gap-1 rounded px-0.5 hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none";

/**
 * Mirrors the TUI status bar: folder · branch + dirty dot · context bar · session name ·
 * model + thinking level · cost (with `(sa $x)` subagent spend once the conversation has a
 * `spawn` call), then extension `setStatus` chips. Model, thinking and context/cost open
 * their pickers / the stats sheet. On desktop the row doesn't wrap and context through cost sit
 * on the right; visual order only, so focus order matches the DOM.
 */
export function StatusBar() {
  const ready = useConversation((s) => s.hydrated && s.agent.status === "ready");
  const cwd = useConversation((s) => s.agent.cwd);
  const git = useConversation((s) => s.gitStatus);
  const percent = useConversation((s) => s.stats?.contextUsage?.percent);
  const cost = useConversation((s) => s.stats?.cost);
  const subagentSpend = useConversation(selectSubagentSpend);
  const name = useConversation(selectSessionName);
  const modelId = useConversation((s) => s.state?.model?.id);
  const reasoning = useConversation((s) => s.state?.model?.reasoning === true);
  const thinking = useConversation((s) => s.state?.thinkingLevel);
  const openSheet = useOpenSheet();

  return (
    <div className="flex flex-col gap-1">
      <div
        data-testid="status-bar"
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground lg:flex-nowrap"
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
                className="size-1.5 rounded-full bg-status-input"
              />
            )}
          </span>
        )}
        <button
          type="button"
          className={cn(itemButton, "shrink-0 lg:order-1 lg:ml-auto")}
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
            className={cn(itemButton, "font-mono lg:order-1")}
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
            className={cn(itemButton, "shrink-0 lg:order-1")}
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
            className={cn(itemButton, "shrink-0 tabular-nums lg:order-1")}
            aria-label={`Cost ${formatCost(cost)}${subagentSpend === undefined ? "" : `, subagents ${formatCost(subagentSpend)}`}`}
            disabled={!ready}
            onClick={() => openSheet("stats")}
          >
            {formatCost(cost)}
            {subagentSpend !== undefined && ` (sa ${formatCost(subagentSpend)})`}
          </button>
        )}
      </div>
      <StatusChips />
    </div>
  );
}
