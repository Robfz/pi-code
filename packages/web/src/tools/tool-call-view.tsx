import { memo } from "react";
import { useRowOpen } from "@/store/ui-prefs";
import "./index";
import { isActive } from "./common";
import { getToolRenderer, type ToolRendererProps } from "./registry";
import { errorLine, ToolRow } from "./tool-row";

export type ToolCallViewProps = Omit<ToolRendererProps, "expanded">;

/**
 * A tool call as a `ToolRow`: the renderer's label, and its body when expanded. Open by default
 * in Detailed, and while running for renderers that `expandWhileRunning`. A finished call without
 * a result (never executed) has no body.
 */
export const ToolCallView = memo(function ToolCallView(props: ToolCallViewProps) {
  const renderer = getToolRenderer(props.toolName);
  const [expanded, setExpanded] = useRowOpen(
    (density) =>
      density === "detailed" || (isActive(props.status) && renderer.expandWhileRunning === true),
  );
  const rendererProps: ToolRendererProps = { ...props, expanded };
  const { Body } = renderer;
  const hasBody =
    isActive(props.status) || props.result !== undefined || props.partialResult !== undefined;

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
      onOpenChange={setExpanded}
    >
      {hasBody ? <Body {...rendererProps} /> : undefined}
    </ToolRow>
  );
});
