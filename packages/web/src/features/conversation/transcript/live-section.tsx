import { useConversation } from "@/store/context";
import { selectBash } from "@/store/selectors";
import { BashExecutionView, bashFromResult } from "./bash-execution";
import { LiveStatusRow } from "./live-status";

/** `!` / `!!` commands in flight (committed as `bashExecution` entries when done). */
function BashRuns() {
  const bash = useConversation(selectBash);
  return Object.entries(bash).map(([id, run]) => (
    <BashExecutionView
      key={id}
      bash={{
        ...bashFromResult(run.command, run.output, run.done),
        excludeFromContext: run.excludeFromContext === true,
      }}
      running={run.done === undefined}
    />
  ));
}

/**
 * After the turns: `!cmd` runs in flight and the live-status row. Pulled up to sit 6px under the
 * last turn, whose line it is.
 */
export function LiveSection() {
  return (
    <div data-testid="live" className="-mt-2.5 flex flex-col gap-4 empty:hidden">
      <BashRuns />
      <LiveStatusRow />
    </div>
  );
}
