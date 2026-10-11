import { TagIcon } from "lucide-react";
import { Fragment, memo, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Step, Turn } from "@/store/turns";
import { AssistantText, StopReasonNotice } from "./assistant-message";
import { renderEntry } from "./entry";
import { useLiveSteps } from "./live-section";
import { Thinking } from "./thinking";
import { ToolCallSlot } from "./tool-call-slot";
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

/**
 * One turn: its user message, then its steps. The last turn also shows what's in flight
 * (`useLiveSteps`); the others render from committed entries only.
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

  if (!turn.user && steps.length === 0) return null;
  const labelled = new Set<string>();
  const userLabel = turn.user && !pending ? labels.get(turn.id) : undefined;

  return (
    <section
      data-testid={live.active ? "live-turn" : "turn"}
      data-turn-id={turn.id}
      className={cn(
        "min-w-0",
        !live.active && "[contain-intrinsic-size:auto_400px] [content-visibility:auto]",
      )}
    >
      {turn.user && (
        <div className="mb-[18px]">
          {userLabel !== undefined && <EntryLabel entryId={turn.id} label={userLabel} />}
          <UserMessageView message={turn.user} pending={pending} />
        </div>
      )}
      {steps.map((step) => {
        let label: string | undefined;
        if (step.entryId !== undefined && !labelled.has(step.entryId)) {
          labelled.add(step.entryId);
          label = labels.get(step.entryId);
        }
        return (
          <Fragment key={step.key}>
            {label !== undefined && step.entryId !== undefined && (
              <EntryLabel entryId={step.entryId} label={label} />
            )}
            <StepView step={step} />
          </Fragment>
        );
      })}
    </section>
  );
});
