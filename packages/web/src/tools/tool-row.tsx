import { CircleAlertIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { CollapsibleRow } from "@/components/collapsible-row";
import { toolResultText } from "@/lib/content";
import { cwdRelative, splitPath } from "@/lib/paths";
import { formatDuration, formatSeconds } from "@/lib/time";
import { useElapsed } from "@/lib/use-elapsed";
import { cn } from "@/lib/utils";
import { useConversationCwd } from "@/store/context";
import { CuratorButton, isActive } from "./common";
import type { ToolLabel, ToolResultPayload, ToolStatus } from "./registry";

export interface ToolRowProps extends Omit<ComponentProps<"div">, "children"> {
  label: ToolLabel;
  status: ToolStatus;
  /** First line of a failed call's error. */
  error?: string;
  durationMs?: number;
  /** Start of a running call (server clock): the tail counts up from it. */
  startedAt?: number;
  curatorUrl?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The renderer's body; a row without one doesn't toggle. */
  children?: ReactNode;
}

/** First non-empty line of a failed call's output. */
export function errorLine(result: ToolResultPayload | undefined): string | undefined {
  return toolResultText(result)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
}

function PathTarget({ path }: { path: string }) {
  // Directories inside the conversation's folder read relative to it.
  const { base, dir } = splitPath(cwdRelative(path, useConversationCwd()));
  return (
    <span data-slot="row-target" className="flex min-w-0 items-baseline gap-1.5 overflow-hidden">
      <span className="shrink-0 text-foreground">{base}</span>
      {dir && (
        <span className="hidden min-w-0 truncate text-faint-foreground lg:inline">{dir}</span>
      )}
    </span>
  );
}

function Target({
  target,
  className,
}: {
  target: NonNullable<ToolLabel["target"]>;
  className?: string;
}) {
  if (target.kind === "path") return <PathTarget path={target.text} />;
  if (target.kind === "code") {
    return (
      <span
        data-slot="row-target"
        className={cn(
          "min-w-0 truncate font-mono text-[12.5px] tracking-[-0.01em] text-subtle-foreground",
          className,
        )}
      >
        {target.text}
      </span>
    );
  }
  return (
    <span data-slot="row-target" className={cn("min-w-0 truncate text-foreground", className)}>
      {target.text}
    </span>
  );
}

/** One tool call: `[icon] Verb target meta … duration ›` over the renderer's body. */
export function ToolRow({
  label,
  status,
  error,
  durationMs,
  startedAt,
  curatorUrl,
  open,
  onOpenChange,
  children,
  className,
  ...rest
}: ToolRowProps) {
  const active = isActive(status);
  const failed = status === "error";
  const ultraspawn = label.tone === "ultraspawn";
  const elapsed = useElapsed(active && durationMs === undefined ? startedAt : undefined);
  const duration =
    durationMs !== undefined
      ? formatDuration(durationMs)
      : elapsed !== undefined
        ? formatSeconds(elapsed)
        : undefined;
  const Icon = failed ? CircleAlertIcon : label.icon;
  const hasMeta = label.meta !== undefined && label.meta !== null && label.meta !== "";

  return (
    <CollapsibleRow
      {...rest}
      data-tone={label.tone}
      className={className}
      open={open}
      onOpenChange={onOpenChange}
      icon={<Icon className={cn(failed ? "text-status-error" : ultraspawn && "text-ultraspawn")} />}
      label={
        <>
          <span
            data-slot="row-verb"
            className={cn(
              "shrink-0 font-medium",
              active
                ? cn("shimmer", ultraspawn && "shimmer-ultraspawn")
                : failed
                  ? "text-status-error"
                  : ultraspawn
                    ? "text-ultraspawn"
                    : "text-foreground",
            )}
          >
            {label.verb}
          </span>
          {label.target && label.target.text !== "" && (
            <Target target={label.target} className={ultraspawn ? "text-ultraspawn" : undefined} />
          )}
          {(hasMeta || error) && (
            <span
              data-slot="row-meta"
              className={cn(
                ultraspawn ? "text-ultraspawn" : "text-muted-foreground",
                "tabular-nums",
                error ? "min-w-0 truncate" : "shrink-0",
              )}
            >
              {label.meta}
              {error && `${hasMeta ? " · " : ""}${error}`}
            </span>
          )}
        </>
      }
      tail={duration}
      collapsed={
        curatorUrl && (
          <div className="flex py-1 lg:pl-[22px]">
            <CuratorButton url={curatorUrl} />
          </div>
        )
      }
    >
      {children !== undefined && children !== null && (
        <div
          data-slot="tool-body"
          className="mt-0.5 mb-2 min-w-0 overflow-hidden rounded-lg border bg-card px-3 py-2.5"
        >
          {children}
        </div>
      )}
    </CollapsibleRow>
  );
}
