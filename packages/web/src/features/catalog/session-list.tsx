import type { SessionSummary } from "@pi-code/protocol";
import { CircleDotIcon, LoaderIcon, MessageSquareIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { baseName } from "@/lib/content";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useOpenAgent } from "./use-open-agent";

/**
 * Sessions as tappable rows: name (or first message), first message, project, last update,
 * "Open" when an agent already has it. Tapping resumes it through `POST /api/agents`.
 */
export function SessionList({
  sessions,
  showProject = true,
  label = "Sessions",
}: {
  sessions: SessionSummary[];
  showProject?: boolean;
  label?: string;
}) {
  const open = useOpenAgent();
  const pendingFile = open.isPending ? (open.variables as { sessionFile?: string }) : undefined;
  return (
    <ul className="flex flex-col gap-2" aria-label={label}>
      {sessions.map((session) => {
        const title = session.name ?? session.firstMessage ?? "Empty session";
        const pending = pendingFile?.sessionFile === session.file;
        return (
          <li key={session.file}>
            <button
              type="button"
              data-testid="session-row"
              disabled={open.isPending}
              onClick={() => open.mutate({ sessionFile: session.file })}
              className="flex w-full min-w-0 items-start gap-3 rounded-xl border bg-card/40 px-3 py-2.5 text-left hover:bg-muted/50 disabled:opacity-70"
            >
              {pending ? (
                <LoaderIcon className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <MessageSquareIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span
                  className={cn(
                    "line-clamp-2 text-sm font-medium break-words",
                    session.name === undefined &&
                      session.firstMessage === undefined &&
                      "text-muted-foreground",
                  )}
                >
                  {title}
                </span>
                {session.name !== undefined && session.firstMessage !== undefined && (
                  <span className="truncate text-xs text-muted-foreground">
                    {session.firstMessage}
                  </span>
                )}
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  {showProject && (
                    <>
                      <span className="truncate" title={session.cwd}>
                        {baseName(session.cwd)}
                      </span>
                      <span aria-hidden>·</span>
                    </>
                  )}
                  <time dateTime={session.updatedAt} className="shrink-0">
                    {formatRelative(session.updatedAt)}
                  </time>
                </span>
              </span>
              {session.ownedBy !== undefined && (
                <Badge variant="secondary" className="gap-1">
                  <CircleDotIcon className="text-emerald-500" /> Open
                </Badge>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
