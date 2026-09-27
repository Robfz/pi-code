import { prettyJson, toolResultText, truncate } from "@/lib/content";
import { cn } from "@/lib/utils";
import type { ToolRenderer, ToolRendererProps } from "./registry";

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

function GenericSummary({ args }: ToolRendererProps) {
  const hint = argsHint(args);
  return hint ? <span className="truncate text-muted-foreground">{hint}</span> : null;
}

export function OutputBlock({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <pre
      className={cn(
        "max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-xs",
        error && "bg-destructive/10 text-destructive",
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
        <details className="group/args" open={status === "streaming"}>
          <summary className="cursor-pointer text-xs text-muted-foreground select-none">
            Arguments
          </summary>
          <OutputBlock text={argsJson} />
        </details>
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
  Summary: GenericSummary,
  Body: GenericBody,
  expandWhileRunning: true,
};
