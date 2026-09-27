/**
 * `/agents/$agentId/diff` (`docs/design/03-web-client.md`, "Diff screen"): `GET git/diff` on
 * open and on refresh; file list with status and `+/−` counts; tapping a file shows its patch.
 * Handles binary files, patches too large to send, and projects outside a git repository.
 */

import type { GitDiffResponse, GitFileDiff } from "@pi-code/protocol";
import { isApiError } from "@pi-code/protocol";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon, FileIcon, RefreshCwIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { countPatchLines, DiffViewer } from "@/components/diff";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiRequestError, errorMessage, isApiRequestError } from "@/lib/api";
import { cn } from "@/lib/utils";

export const gitDiffQueryKey = (agentId: string) => ["agent", agentId, "git-diff"] as const;

export async function fetchGitDiff(agentId: string): Promise<GitFileDiff[]> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/git/diff`);
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (isApiError(body)) {
      throw new ApiRequestError(res.status, body.error.code, body.error.message);
    }
    const error = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    if (typeof error?.code === "string") {
      throw new ApiRequestError(res.status, error.code, String(error.message ?? res.statusText));
    }
    throw new ApiRequestError(res.status, `http_${res.status}`, res.statusText || "Request failed");
  }
  return ((await res.json()) as GitDiffResponse).files;
}

const STATUS: Record<GitFileDiff["status"], { letter: string; label: string; className: string }> =
  {
    added: { letter: "A", label: "Added", className: "text-emerald-600 dark:text-emerald-400" },
    untracked: {
      letter: "U",
      label: "Untracked",
      className: "text-emerald-600 dark:text-emerald-400",
    },
    modified: { letter: "M", label: "Modified", className: "text-amber-600 dark:text-amber-400" },
    deleted: { letter: "D", label: "Deleted", className: "text-red-600 dark:text-red-400" },
    renamed: { letter: "R", label: "Renamed", className: "text-sky-600 dark:text-sky-400" },
  };

function FileRow({ file }: { file: GitFileDiff }) {
  const [open, setOpen] = useState(false);
  const counts = useMemo(
    () => (file.patch ? countPatchLines(file.patch) : undefined),
    [file.patch],
  );
  const status = STATUS[file.status] ?? STATUS.modified;
  return (
    <li data-testid="diff-file" data-path={file.path} className="rounded-lg border bg-card/40">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm"
      >
        <ChevronRightIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span
          title={status.label}
          className={cn(
            "w-4 shrink-0 text-center font-mono text-xs font-semibold",
            status.className,
          )}
        >
          <span aria-hidden>{status.letter}</span>
          <span className="sr-only">{status.label}</span>
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {file.oldPath && file.oldPath !== file.path && (
            <span className="text-muted-foreground">{file.oldPath} → </span>
          )}
          {file.path}
        </span>
        {file.binary ? (
          <span className="shrink-0 text-xs text-muted-foreground">binary</span>
        ) : file.tooLarge ? (
          <span className="shrink-0 text-xs text-muted-foreground">too large</span>
        ) : (
          counts && (
            <span className="shrink-0 font-mono text-xs tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">+{counts.additions}</span>{" "}
              <span className="text-red-600 dark:text-red-400">−{counts.deletions}</span>
            </span>
          )
        )}
      </button>
      {open && (
        <div className="border-t p-2">
          {file.binary ? (
            <p className="text-xs text-muted-foreground">Binary file, no text diff.</p>
          ) : file.tooLarge ? (
            <p className="text-xs text-muted-foreground">
              This diff is too large to show here (over 1 MB).
            </p>
          ) : file.patch ? (
            <DiffViewer patch={file.patch} fileName={file.path} />
          ) : (
            <p className="text-xs text-muted-foreground">No textual changes.</p>
          )}
        </div>
      )}
    </li>
  );
}

function Totals({ files }: { files: GitFileDiff[] }) {
  const { additions, deletions } = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      if (!file.patch) continue;
      const counts = countPatchLines(file.patch);
      additions += counts.additions;
      deletions += counts.deletions;
    }
    return { additions, deletions };
  }, [files]);
  return (
    <p className="px-1 text-xs text-muted-foreground">
      {files.length} {files.length === 1 ? "file" : "files"} changed ·{" "}
      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>{" "}
      <span className="text-red-600 dark:text-red-400">−{deletions}</span>
    </p>
  );
}

export function DiffScreen() {
  const { agentId = "" } = useParams({ strict: false }) as { agentId?: string };
  const diff = useQuery({
    queryKey: gitDiffQueryKey(agentId),
    queryFn: () => fetchGitDiff(agentId),
    enabled: agentId !== "",
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: (count, error) => !isApiRequestError(error, "not_a_git_repo") && count < 1,
  });

  let body: ReactNode;
  if (diff.isPending) {
    body = (
      <div data-testid="diff-loading" className="flex flex-col gap-2">
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
      </div>
    );
  } else if (diff.isError) {
    body = isApiRequestError(diff.error, "not_a_git_repo") ? (
      <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
        <FileIcon className="size-6" />
        <p>This project isn't a git repository.</p>
      </div>
    ) : (
      <div className="flex flex-col items-start gap-2 text-sm">
        <p className="text-destructive">Couldn't load the diff: {errorMessage(diff.error)}</p>
        <Button size="sm" variant="outline" onClick={() => void diff.refetch()}>
          Retry
        </Button>
      </div>
    );
  } else if (diff.data.length === 0) {
    body = (
      <p className="py-10 text-center text-sm text-muted-foreground">
        No changes. The working tree is clean.
      </p>
    );
  } else {
    body = (
      <div className="flex flex-col gap-2">
        <Totals files={diff.data} />
        <ul className="flex flex-col gap-2">
          {diff.data.map((file) => (
            <FileRow key={`${file.oldPath ?? ""}:${file.path}`} file={file} />
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-3 px-2 pb-6 pt-[env(safe-area-inset-top)]">
      <header className="flex h-12 items-center gap-1">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/agents/$agentId" params={{ agentId }} aria-label="Back to conversation">
            <ChevronLeftIcon />
          </Link>
        </Button>
        <h1 className="flex-1 text-sm font-medium">Git diff</h1>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh"
          disabled={diff.isFetching || agentId === ""}
          onClick={() => void diff.refetch()}
        >
          <RefreshCwIcon className={cn(diff.isFetching && "animate-spin")} />
        </Button>
      </header>
      {body}
    </div>
  );
}
