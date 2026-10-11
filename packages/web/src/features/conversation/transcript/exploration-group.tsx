import { TelescopeIcon } from "lucide-react";
import type { ReactNode } from "react";
import { CollapsibleRow } from "@/components/collapsible-row";
import { useConversation } from "@/store/context";
import { useRowOpen } from "@/store/ui-prefs";
import { getToolRenderer } from "@/tools";
import { CuratorButton, isActive } from "@/tools/common";
import type { ToolLabel } from "@/tools/registry";
import { splitPath } from "@/tools/tool-row";
import { type ExplorationGroup, groupCountLabel } from "./grouping";
import { toolStatus } from "./tool-call-slot";

type ToolStep = Extract<ExplorationGroup["steps"][number], { kind: "tool" }>;

/** A target as the group label shows it: a path's basename, else the pattern or query. */
function shortTarget(target: ToolLabel["target"]): string {
  if (!target) return "";
  return target.kind === "path" ? splitPath(target.text).base : target.text;
}

/** "Reading foo.ts": a running call's verb and short target. */
function runningPhrase(step: ToolStep, args: unknown): string {
  const label = getToolRenderer(step.toolName).label({
    toolCallId: step.toolCallId,
    toolName: step.toolName,
    args,
    argsText: step.argsText,
    status: step.streaming ? "streaming" : "running",
    isError: false,
    expanded: false,
  });
  return [label.verb, shortTarget(label.target)].filter(Boolean).join(" ");
}

function ChildCurator({ toolCallId }: { toolCallId: string }) {
  const url = useConversation((s) => s.live.curator[toolCallId]);
  return url ? (
    <div className="flex py-1 lg:pl-[22px]">
      <CuratorButton url={url} />
    </div>
  ) : null;
}

/**
 * Consecutive exploration calls as one row: "Exploring · Reading foo.ts" while a call runs,
 * then "Explored 3 files, 2 searches"; `children` (the calls' rows) in its body.
 */
export function ExplorationGroupRow({
  group,
  children,
}: {
  group: ExplorationGroup;
  children: ReactNode;
}) {
  const [open, setOpen] = useRowOpen(() => false);
  const tools = group.steps.filter((step): step is ToolStep => step.kind === "tool");
  const running = useConversation((s) =>
    tools.find((step) => isActive(toolStatus(s, step.toolCallId, step.streaming))),
  );
  const runningArgs = useConversation((s) =>
    running ? (s.live.tools[running.toolCallId]?.args ?? running.args) : undefined,
  );

  return (
    <CollapsibleRow
      data-testid="exploration-group"
      data-status={running ? "running" : "done"}
      open={open}
      onOpenChange={setOpen}
      icon={<TelescopeIcon />}
      label={
        running ? (
          <span data-slot="row-verb" className="shimmer min-w-0 truncate font-medium">
            Exploring · {runningPhrase(running, runningArgs)}
          </span>
        ) : (
          <>
            <span data-slot="row-verb" className="shrink-0 font-medium text-foreground">
              Explored
            </span>
            <span data-slot="row-meta" className="min-w-0 truncate text-muted-foreground">
              {groupCountLabel(tools)}
            </span>
          </>
        )
      }
      collapsed={tools.map((step) => <ChildCurator key={step.key} toolCallId={step.toolCallId} />)}
    >
      <div className="pb-1">{children}</div>
    </CollapsibleRow>
  );
}
