import { memo, useEffect, useState } from "react";
import { useUiPrefs } from "@/store/ui-prefs";
import "./index";
import { getToolRenderer, type ToolRendererProps } from "./registry";
import { errorLine, ToolRow } from "./tool-row";

export type ToolCallViewProps = Omit<ToolRendererProps, "expanded">;

/** A tool call as a `ToolRow`: the renderer's label, and its body when expanded. */
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
  const { Body } = renderer;

  return (
    <ToolRow
      data-testid="tool-call"
      data-tool={props.toolName}
      data-status={props.status}
      label={renderer.label(rendererProps)}
      status={props.status}
      error={props.status === "error" ? errorLine(props.result) : undefined}
      durationMs={props.durationMs}
      startedAt={props.startedAt}
      curatorUrl={props.curatorUrl}
      open={expanded}
      onOpenChange={setOverride}
    >
      <Body {...rendererProps} />
    </ToolRow>
  );
});
