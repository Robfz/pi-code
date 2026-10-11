import type { BashExecutionMessage, BashResult } from "@pi-code/protocol";
import { SquareTerminalIcon } from "lucide-react";
import { CollapsibleRow } from "@/components/collapsible-row";
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

function Status({ bash, running }: { bash: BashView; running: boolean }) {
  if (running) return <span className="shimmer shrink-0">running…</span>;
  if (bash.cancelled) return <span className="shrink-0 text-muted-foreground">cancelled</span>;
  if (bash.exitCode === undefined || bash.exitCode === 0) return null;
  return <span className="shrink-0 text-status-error tabular-nums">exit {bash.exitCode}</span>;
}

/**
 * `!` / `!!` command: command and a non-zero exit code over its output (open unless long); muted
 * when `!!`.
 */
export function BashExecutionView({
  bash,
  running = false,
}: {
  bash: BashView;
  running?: boolean;
}) {
  const output = bash.output.replace(/\n$/, "");
  const lines = output === "" ? 0 : output.split("\n").length;
  const hasBody = lines > 0 || bash.truncated;
  return (
    <CollapsibleRow
      data-testid="bash-execution"
      data-excluded={bash.excludeFromContext ? "true" : undefined}
      className={cn(bash.excludeFromContext && "opacity-60")}
      icon={<SquareTerminalIcon />}
      defaultOpen={running || lines <= COLLAPSE_LINES}
      label={
        <>
          <code className="min-w-0 truncate font-mono text-[12.5px] tracking-[-0.01em] text-subtle-foreground">
            {bash.excludeFromContext ? "!! " : "$ "}
            {bash.command}
          </code>
          <Status bash={bash} running={running} />
        </>
      }
    >
      {hasBody && (
        <div className="mt-0.5 mb-2 flex flex-col gap-2 rounded-lg border bg-card px-3 py-2.5">
          {lines > 0 && (
            <pre className="max-h-96 overflow-auto font-mono text-[12.5px] leading-[1.6] tracking-[-0.01em] whitespace-pre-wrap break-words text-subtle-foreground">
              {output}
            </pre>
          )}
          {bash.truncated && (
            <p className="text-xs text-muted-foreground">
              Output truncated
              {bash.fullOutputPath ? ` · full output in ${bash.fullOutputPath}` : ""}
            </p>
          )}
        </div>
      )}
    </CollapsibleRow>
  );
}
