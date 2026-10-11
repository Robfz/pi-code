import type { SessionEntry } from "@pi-code/protocol";
import { ListChecksIcon, TagIcon } from "lucide-react";
import { createContext, memo, type ReactNode, useContext, useMemo } from "react";
import { CollapsibleRow } from "@/components/collapsible-row";
import { Badge } from "@/components/ui/badge";
import { formatSeconds } from "@/lib/time";
import { cn } from "@/lib/utils";
import { type Step, type Turn, turnStats } from "@/store/turns";
import { useRowOpen, useUiPrefs } from "@/store/ui-prefs";
import { AssistantText, StopReasonNotice } from "./assistant-message";
import { renderEntry } from "./entry";
import { ExplorationGroupRow } from "./exploration-group";
import { failedToolCalls, foldSteps, groupSteps, type Item } from "./grouping";
import { useLiveSteps } from "./live-section";
import { Thinking } from "./thinking";
import { ToolCallSlot } from "./tool-call-slot";
import { TurnFooter } from "./turn-footer";
import { UserMessageView } from "./user-message";

const StepView = memo(function StepView({ step }: { step: Step }) {
  switch (step.kind) {
    case "text":
      return (
        <div className="my-3 first:mt-0 last:mb-0">
          <AssistantText text={step.text} streaming={step.streaming} />
        </div>
      );
    case "thinking":
      return (
        <Thinking
          text={step.text}
          live={step.live}
          redacted={step.redacted}
          startedAt={step.startedAt}
          endedAt={step.endedAt}
          durationKey={step.durationKey}
        />
      );
    case "tool":
      return (
        <ToolCallSlot
          toolCallId={step.toolCallId}
          toolName={step.toolName}
          args={step.args}
          argsText={step.argsText}
          streaming={step.streaming}
        />
      );
    case "stop":
      return (
        <div className="my-2">
          <StopReasonNotice message={step.message} />
        </div>
      );
    case "entry": {
      const content = renderEntry(step.entry);
      return content && <div className="my-3 min-w-0 first:mt-0 last:mb-0">{content}</div>;
    }
  }
});

function EntryLabel({ entryId, label }: { entryId: string; label: string }) {
  return (
    <div data-entry-id={entryId} className="mb-1 flex justify-end">
      <Badge variant="outline" data-testid="entry-label">
        <TagIcon /> {label}
      </Badge>
    </div>
  );
}

/** Labels by the key of the first step of each labelled entry. */
const StepLabels = createContext<ReadonlyMap<string, string>>(new Map());

function StepItem({ step }: { step: Step }) {
  const label = useContext(StepLabels).get(step.key);
  return (
    <>
      {label !== undefined && step.entryId !== undefined && (
        <EntryLabel entryId={step.entryId} label={label} />
      )}
      <StepView step={step} />
    </>
  );
}

function Items({ items }: { items: readonly Item[] }) {
  return items.map((item) =>
    item.kind === "group" ? (
      <ExplorationGroupRow key={item.key} group={item}>
        {item.steps.map((step) => (
          <StepItem key={step.key} step={step} />
        ))}
      </ExplorationGroupRow>
    ) : (
      <StepItem key={item.key} step={item} />
    ),
  );
}

/** Compact's fold of a finished turn's work: "Worked for 2m 14s", the steps grouped in its body. */
function WorkedRow({ turn, children }: { turn: Turn; children: ReactNode }) {
  const [open, setOpen] = useRowOpen(() => false);
  const durationMs = useMemo(() => turnStats(turn).durationMs, [turn]);
  return (
    <CollapsibleRow
      data-testid="worked"
      open={open}
      onOpenChange={setOpen}
      icon={<ListChecksIcon />}
      label={
        <span data-slot="row-verb" className="font-[450] text-muted-foreground">
          {durationMs === undefined ? "Worked" : `Worked for ${formatSeconds(durationMs)}`}
        </span>
      }
    >
      <div className="pb-1">{children}</div>
    </CollapsibleRow>
  );
}

/**
 * What a turn shows of its steps for the density: every step (Detailed), exploration grouped
 * (Balanced), or, in Compact, the work folded into a "Worked" row (finished) or the latest text
 * alone (live).
 */
function TurnBody({
  turn,
  steps,
  live,
  failed,
}: {
  turn: Turn;
  steps: Step[];
  live: boolean;
  failed: ReadonlySet<string>;
}) {
  const density = useUiPrefs((s) => s.density);
  const view = useMemo(() => {
    if (density === "detailed") return { items: steps };
    if (density === "balanced") return { items: groupSteps(steps, failed) };
    if (live) return { items: steps.filter((step) => step.kind === "text").slice(-1) };
    const { folded, rest } = foldSteps(steps);
    return { worked: folded.length > 0 ? groupSteps(folded, failed) : undefined, items: rest };
  }, [density, steps, live, failed]);

  return (
    <>
      {view.worked && (
        <WorkedRow turn={turn}>
          <Items items={view.worked} />
        </WorkedRow>
      )}
      <Items items={view.items} />
    </>
  );
}

const isAssistantEntry = (entry: SessionEntry) =>
  entry.type === "message" && entry.message.role === "assistant";

/**
 * One turn: its user message, then its steps, and a footer once it's finished. The last turn also
 * shows what's in flight (`useLiveSteps`); the others render from committed entries only.
 */
export const TurnView = memo(function TurnView({
  turn,
  last = false,
  pending = false,
  labels,
}: {
  turn: Turn;
  /** The transcript's last turn: the one live state continues. */
  last?: boolean;
  /** A user message not committed yet. */
  pending?: boolean;
  labels: Map<string, string>;
}) {
  const live = useLiveSteps(last);
  const steps = useMemo(() => {
    if (live.steps.length === 0) return turn.steps;
    // An entry committed in the same update its live state clears in never shows twice.
    const committed = new Set(turn.steps.map((step) => step.key));
    return [...turn.steps, ...live.steps.filter((step) => !committed.has(step.key))];
  }, [turn.steps, live.steps]);
  const committedFailures = useMemo(() => failedToolCalls(turn.entries), [turn.entries]);
  const failed = useMemo(
    () =>
      live.failed.size === 0 ? committedFailures : new Set([...committedFailures, ...live.failed]),
    [committedFailures, live.failed],
  );
  const stepLabels = useMemo(() => {
    const byStep = new Map<string, string>();
    const seen = new Set<string>();
    for (const step of steps) {
      if (step.entryId === undefined || seen.has(step.entryId)) continue;
      seen.add(step.entryId);
      const label = labels.get(step.entryId);
      if (label !== undefined) byStep.set(step.key, label);
    }
    return byStep;
  }, [steps, labels]);

  if (!turn.user && steps.length === 0) return null;
  const finished = !live.active && !pending && turn.entries.some(isAssistantEntry);
  const userLabel = turn.user && !pending ? labels.get(turn.id) : undefined;

  return (
    <section
      data-testid={live.active ? "live-turn" : "turn"}
      data-turn-id={turn.id}
      className={cn(
        "group/turn min-w-0",
        !live.active && "[contain-intrinsic-size:auto_400px] [content-visibility:auto]",
      )}
    >
      {turn.user && (
        <div className="mb-[18px]">
          {userLabel !== undefined && <EntryLabel entryId={turn.id} label={userLabel} />}
          <UserMessageView message={turn.user} pending={pending} />
        </div>
      )}
      <StepLabels.Provider value={stepLabels}>
        <TurnBody turn={turn} steps={steps} live={live.active} failed={failed} />
      </StepLabels.Provider>
      {finished && <TurnFooter turn={turn} />}
    </section>
  );
});
