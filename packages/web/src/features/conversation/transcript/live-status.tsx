import { CircleAlertIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { formatSeconds } from "@/lib/time";
import { useElapsed } from "@/lib/use-elapsed";
import { useConversation } from "@/store/context";
import { selectActiveBranch, selectLiveActivity, selectRun } from "@/store/selectors";
import { useUiPrefs } from "@/store/ui-prefs";
import "@/tools";

function RunTimer({ startedAt }: { startedAt: number }) {
  const elapsed = useElapsed(startedAt) ?? 0;
  return (
    <span data-testid="live-timer" className="text-faint-foreground tabular-nums">
      · {formatSeconds(elapsed)}
    </span>
  );
}

/** A run that failed outside an assistant message (an assistant error shows on its message). */
function RunError() {
  const run = useConversation(selectRun);
  const lastAssistantError = useConversation((s) => {
    const branch = selectActiveBranch(s);
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry?.type === "message" && entry.message.role === "assistant") {
        return entry.message.errorMessage;
      }
    }
    return undefined;
  });
  if (run.active || !run.lastError || run.lastError === lastAssistantError) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
      <span className="break-words">{run.lastError}</span>
    </div>
  );
}

/**
 * The live turn's last line (`docs/design/09-ui-overhaul.md`, "Live-status row"): what the agent
 * is doing and for how long, "Running pnpm test · 42s". Outside Compact it only shows when no
 * row above shimmers, so it never repeats a running row. Then the run's error, if any.
 */
export function LiveStatusRow() {
  const activity = useConversation(useShallow(selectLiveActivity));
  const startedAt = useConversation((s) => s.live.run.startedAt);
  const compact = useUiPrefs((s) => s.density === "compact");
  const shown = activity !== undefined && (compact || !activity.rowShimmers);
  return (
    <>
      {shown && (
        <div
          data-testid="live-status"
          className="flex h-7 min-w-0 items-center gap-1.5 text-sm whitespace-nowrap"
        >
          <span className="shimmer min-w-0 truncate">{activity.phrase}</span>
          {startedAt !== undefined && <RunTimer startedAt={startedAt} />}
        </div>
      )}
      <RunError />
    </>
  );
}
