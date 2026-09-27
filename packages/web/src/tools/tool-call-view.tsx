import { ChevronRightIcon, CircleAlertIcon, LoaderIcon, WrenchIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useUiPrefs } from "@/store/ui-prefs";
import "./index";
import { getToolRenderer, type ToolRendererProps } from "./registry";

export type ToolCallViewProps = Omit<ToolRendererProps, "expanded">;

/** Frame around a tool renderer: header (name, summary, status, toggle) and expandable body. */
export const ToolCallView = memo(function ToolCallView(props: ToolCallViewProps) {
  const globalExpanded = useUiPrefs((s) => s.toolsExpanded);
  const [override, setOverride] = useState<boolean | undefined>(undefined);
  // The global toggle wins over a per-tool choice made before it.
  useEffect(() => {
    void globalExpanded;
    setOverride(undefined);
  }, [globalExpanded]);

  const renderer = getToolRenderer(props.toolName);
  const active = props.status === "running" || props.status === "streaming";
  const expanded = override ?? (globalExpanded || (active && renderer.expandWhileRunning === true));
  const rendererProps: ToolRendererProps = { ...props, expanded };
  const { Summary, Body } = renderer;

  return (
    <div
      data-testid="tool-call"
      data-tool={props.toolName}
      data-status={props.status}
      className={cn(
        "min-w-0 rounded-lg border bg-card/40 text-sm",
        props.status === "error" && "border-destructive/50",
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOverride(!expanded)}
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
        <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-mono text-xs font-medium">{props.toolName || "tool"}</span>
        <span className="min-w-0 flex-1 truncate text-xs">
          {Summary && <Summary {...rendererProps} />}
        </span>
        {active && (
          <LoaderIcon
            aria-label="Running"
            className="size-3.5 shrink-0 animate-spin text-muted-foreground"
          />
        )}
        {props.status === "error" && (
          <CircleAlertIcon aria-label="Failed" className="size-3.5 shrink-0 text-destructive" />
        )}
      </button>
      {expanded && (
        <div className="border-t px-2.5 py-2">
          <Body {...rendererProps} />
        </div>
      )}
    </div>
  );
});
