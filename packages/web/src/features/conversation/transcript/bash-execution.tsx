import type { BashExecutionMessage, BashResult } from "@pi-code/protocol";
import { TerminalIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const COLLAPSE_LINES = 12;

type BashView = Pick<
  BashExecutionMessage,
  "command" | "output" | "exitCode" | "cancelled" | "truncated" | "excludeFromContext"
> & { fullOutputPath?: string };

export function bashFromResult(command: string, output: string, result?: BashResult): BashView {
  return {
    command,
    output,
    exitCode: result?.exitCode,
    cancelled: result?.cancelled ?? false,
    truncated: result?.truncated ?? false,
    fullOutputPath: result?.fullOutputPath,
  };
}

/** `!` / `!!` command: command, output (collapsed if long), exit code; muted when `!!`. */
export function BashExecutionView({
  bash,
  running = false,
}: {
  bash: BashView;
  running?: boolean;
}) {
  const output = bash.output.replace(/\n$/, "");
  const lines = output === "" ? 0 : output.split("\n").length;
  const outputBlock = (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words px-2.5 pb-2 font-mono text-xs">
      {output}
    </pre>
  );
  return (
    <div
      data-testid="bash-execution"
      data-excluded={bash.excludeFromContext ? "true" : undefined}
      className={cn("rounded-lg border bg-card/40", bash.excludeFromContext && "opacity-60")}
    >
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
        <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <code className="min-w-0 flex-1 truncate font-mono text-xs">
          {bash.excludeFromContext ? "!! " : "$ "}
          {bash.command}
        </code>
        {running && <span className="text-xs text-muted-foreground">running…</span>}
        {bash.cancelled && <Badge variant="outline">cancelled</Badge>}
        {!running && !bash.cancelled && bash.exitCode !== undefined && (
          <Badge variant={bash.exitCode === 0 ? "secondary" : "destructive"}>
            exit {bash.exitCode}
          </Badge>
        )}
      </div>
      {lines > 0 &&
        (lines > COLLAPSE_LINES && !running ? (
          <details>
            <summary className="cursor-pointer px-2.5 pb-1.5 text-xs text-muted-foreground select-none">
              {lines} lines of output
            </summary>
            {outputBlock}
          </details>
        ) : (
          outputBlock
        ))}
      {bash.truncated && (
        <p className="px-2.5 pb-2 text-xs text-muted-foreground">
          Output truncated{bash.fullOutputPath ? ` · full output in ${bash.fullOutputPath}` : ""}
        </p>
      )}
    </div>
  );
}
