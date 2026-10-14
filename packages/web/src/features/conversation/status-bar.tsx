import { FolderIcon, GitBranchIcon, LoaderCircleIcon } from "lucide-react";
import { baseName } from "@/lib/content";
import { formatCost } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useConversation } from "@/store/context";
import { selectSubagentSpend, selectWorking } from "@/store/selectors";
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
        : "bg-muted-foreground";
  return (
    <span
      data-testid="context-bar"
      data-filled={filled}
      className="flex items-center gap-1.5"
      title={known ? `Context ${Math.round(percent)}%` : "Context usage unknown"}
    >
      <span className="flex gap-0.5">
        {Array.from({ length: CONTEXT_CELLS }, (_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed cells
            key={i}
            data-cell={i < filled ? "filled" : "empty"}
            className={cn("h-2 w-[7px] rounded-[2px]", i < filled ? tone : "bg-input")}
          />
        ))}
      </span>
      <span className="max-lg:hidden">{known ? `${Math.round(percent)}%` : "?"}</span>
    </span>
  );
}

/**
 * "Working" while the run is active, compacting or retrying; below 640px only, where the header
 * hides its own timed run state.
 */
export function RunIndicator() {
  const working = useConversation(selectWorking);
  if (!working) return null;
  return (
    <span
      data-testid="run-indicator"
      className="flex shrink-0 items-center gap-1.5 text-foreground sm:hidden"
    >
      <LoaderCircleIcon aria-hidden className="size-[11px] animate-spin text-muted-foreground" />{" "}
      Working
    </span>
  );
}

const itemButton =
  "inline-flex min-w-0 shrink-0 items-center rounded px-0.5 hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none";

/**
 * One line under the composer (`docs/design/09-ui-overhaul.md`, "Status bar"): folder (from
 * 1024px), branch + dirty dot, then on the right the context bar (percentage from 1024px), the
 * cost (with `(sa $x)` subagent spend once the conversation has a `spawn` call) and Working
 * (below 640px);
 * extension `setStatus` chips below. The context bar and cost open the stats sheet.
 */
export function StatusBar() {
  const ready = useConversation((s) => s.hydrated && s.agent.status === "ready");
  const cwd = useConversation((s) => s.agent.cwd);
  const git = useConversation((s) => s.gitStatus);
  const percent = useConversation((s) => s.stats?.contextUsage?.percent);
  const cost = useConversation((s) => s.stats?.cost);
  const subagentSpend = useConversation(selectSubagentSpend);
  const openSheet = useOpenSheet();

  return (
    <div className="flex flex-col gap-1">
      <div
        data-testid="status-bar"
        className="flex h-[30px] min-w-0 items-center gap-[9px] px-0.5 text-xs whitespace-nowrap text-faint-foreground tabular-nums lg:gap-2.5 lg:px-1.5"
      >
        {cwd !== "" && (
          <span
            data-testid="status-folder"
            className="flex min-w-0 items-center gap-1.5 max-lg:hidden"
            title={cwd}
          >
            <FolderIcon className="size-3 shrink-0" />
            <span className="max-w-48 truncate">{baseName(cwd)}</span>
          </span>
        )}
        {git?.branch && (
          <span data-testid="status-branch" className="flex min-w-0 items-center gap-1.5">
            <GitBranchIcon className="size-3 shrink-0" />
            <span className="truncate font-mono text-[11.5px] text-muted-foreground">
              {git.branch}
            </span>
            {git.dirty && (
              <span
                data-testid="status-dirty"
                role="img"
                aria-label="uncommitted changes"
                title="Uncommitted changes"
                className="size-1.5 shrink-0 rounded-full bg-status-input"
              />
            )}
          </span>
        )}
        <button
          type="button"
          className={cn(itemButton, "ml-auto")}
          aria-label="Session stats"
          disabled={!ready}
          onClick={() => openSheet("stats")}
        >
          <ContextBar percent={percent} />
        </button>
        {cost !== undefined && (
          <button
            type="button"
            className={itemButton}
            aria-label={`Cost ${formatCost(cost)}${subagentSpend === undefined ? "" : `, subagents ${formatCost(subagentSpend)}`}`}
            disabled={!ready}
            onClick={() => openSheet("stats")}
          >
            {formatCost(cost)}
            {subagentSpend !== undefined && ` (sa ${formatCost(subagentSpend)})`}
          </button>
        )}
        <RunIndicator />
      </div>
      <StatusChips />
    </div>
  );
}
