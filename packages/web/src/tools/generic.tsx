import { WrenchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { CollapsibleRow } from "@/components/collapsible-row";
import { prettyJson, toolResultText, truncate } from "@/lib/content";
import { cn } from "@/lib/utils";
import type { ToolLabel, ToolRenderer, ToolRendererProps } from "./registry";

function hasArgs(args: unknown): boolean {
  if (args === undefined || args === null) return false;
  if (typeof args === "object") return Object.keys(args).length > 0;
  return true;
}

/** First short string argument, as a hint of what the call does. */
export function argsHint(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.trim() !== "") return truncate(value, 80);
  }
  return undefined;
}

function genericLabel({ toolName, args, status }: ToolRendererProps): ToolLabel {
  const name = toolName || "tool";
  const hint = argsHint(args);
  return {
    icon: WrenchIcon,
    verb: status === "error" ? `${name} failed` : name,
    target: hint ? { kind: "text", text: hint } : undefined,
  };
}

/** A collapsible sub-section of a tool body ("Arguments", "Full results"). */
export function BodySection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <CollapsibleRow
      label={<span className="text-xs text-muted-foreground">{title}</span>}
      defaultOpen={defaultOpen}
      bodyClassName="pt-1"
    >
      {children}
    </CollapsibleRow>
  );
}

export function OutputBlock({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <pre
      className={cn(
        "max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-[1.6] text-subtle-foreground",
        error && "text-destructive",
      )}
    >
      {text}
    </pre>
  );
}

function GenericBody({
  args,
  argsText,
  status,
  partialResult,
  result,
  isError,
}: ToolRendererProps) {
  const argsJson = status === "streaming" && argsText !== undefined ? argsText : prettyJson(args);
  const partial = toolResultText(partialResult);
  const output = toolResultText(result);
  return (
    <div className="flex flex-col gap-2">
      {(hasArgs(args) || (argsText ?? "") !== "") && (
        // Open while the arguments stream in; collapsed again once they're complete.
        <BodySection
          key={String(status === "streaming")}
          title="Arguments"
          defaultOpen={status === "streaming"}
        >
          <OutputBlock text={argsJson} />
        </BodySection>
      )}
      {result === undefined && partial !== "" && <OutputBlock text={partial} />}
      {result !== undefined &&
        (output !== "" ? (
          <OutputBlock text={output} error={isError} />
        ) : (
          <p className={cn("text-xs text-muted-foreground", isError && "text-destructive")}>
            {isError ? "Failed (no output)" : "No output"}
          </p>
        ))}
    </div>
  );
}

/** Tool name, arguments (JSON, collapsed), streaming partial text, result text, error state. */
export const genericToolRenderer: ToolRenderer = {
  label: genericLabel,
  Body: GenericBody,
  expandWhileRunning: true,
};
