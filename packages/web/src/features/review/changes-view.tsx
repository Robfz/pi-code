/**
 * The Changes tab (`docs/design/07-code-review.md`, "Changes tab"): the git diff of the agent's
 * project in uncommitted or branch mode, as a file list whose patches send line references to the
 * composer, versioned per "Version naming".
 */

import type { CodeRef, GitDiffResponse, GitFileDiff } from "@pi-code/protocol";
import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { countPatchLines, type LineSelection } from "@/components/diff";
import { Skeleton } from "@/components/ui/skeleton";
import { getGitBranches, getGitDiff, isApiRequestError } from "@/lib/api";
import { queryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { LoadError, NotARepo, retryServerErrors } from "./query-states";
import { type DiffMode, useReview, useReviewStore } from "./review-state";
import { SelectableDiff } from "./selectable-diff";

const STATUS: Record<GitFileDiff["status"], { letter: string; label: string; className: string }> =
  {
    added: { letter: "A", label: "Added", className: "text-diff-add" },
    untracked: { letter: "U", label: "Untracked", className: "text-diff-add" },
    modified: { letter: "M", label: "Modified", className: "text-status-input" },
    deleted: { letter: "D", label: "Deleted", className: "text-diff-del" },
    renamed: { letter: "R", label: "Renamed", className: "text-muted-foreground" },
  };

/**
 * The reference for lines of `file`: old-side lines name the old commit; new-side lines name
 * `HEAD` only when it is the new side and the working tree differs from it.
 */
function changeReference(
  file: GitFileDiff,
  { oldRev, newRev }: Pick<GitDiffResponse, "oldRev" | "newRev">,
  { side, start, end }: LineSelection,
): CodeRef {
  const ref: CodeRef =
    side === "old"
      ? { path: file.oldPath ?? file.path, start, end }
      : { path: file.path, start, end };
  const rev = side === "old" ? oldRev : file.worktreeChanged ? newRev : undefined;
  if (rev !== undefined) ref.rev = rev;
  return ref;
}

function FileRow({
  file,
  toReference,
  onAdded,
}: {
  file: GitFileDiff;
  toReference(selection: LineSelection): CodeRef;
  onAdded?(): void;
}) {
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
              <span className="text-diff-add">+{counts.additions}</span>{" "}
              <span className="text-diff-del">−{counts.deletions}</span>
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
            <SelectableDiff
              patch={file.patch}
              fileName={file.path}
              toReference={toReference}
              {...(onAdded && { onAdded })}
            />
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
      <span className="text-diff-add">+{additions}</span>{" "}
      <span className="text-diff-del">−{deletions}</span>
    </p>
  );
}

function Loading() {
  return (
    <div data-testid="diff-loading" className="flex flex-col gap-2">
      <Skeleton className="h-9" />
      <Skeleton className="h-9" />
      <Skeleton className="h-9" />
    </div>
  );
}

export function ChangesView({ agentId, onAdded }: { agentId: string; onAdded?(): void }) {
  const { diff: mode } = useReview(agentId);
  const branchMode = mode.mode === "branch";
  const id = useId();

  const branches = useQuery({
    queryKey: queryKeys.gitBranches(agentId),
    queryFn: () => getGitBranches(agentId),
    enabled: branchMode,
    refetchOnWindowFocus: false,
    retry: retryServerErrors,
  });
  const base = mode.base ?? branches.data?.defaultBranch ?? undefined;
  const diff = useQuery({
    queryKey: branchMode
      ? queryKeys.gitDiff(agentId, "branch", base, mode.uncommitted)
      : queryKeys.gitDiff(agentId, "uncommitted"),
    queryFn: () => getGitDiff(agentId, branchMode ? { base, uncommitted: mode.uncommitted } : {}),
    enabled: !branchMode || base !== undefined,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: retryServerErrors,
  });

  const update = (change: Partial<DiffMode>) =>
    useReviewStore.getState().setDiffMode(agentId, change);

  if (
    isApiRequestError(diff.error, "not_a_git_repo") ||
    isApiRequestError(branches.error, "not_a_git_repo")
  ) {
    return <NotARepo />;
  }

  const options = branches.data?.branches ?? [];
  const modeBar = (
    <div className="flex flex-col gap-2 px-1 text-sm">
      <div role="radiogroup" aria-label="Diff mode" className="flex items-center gap-4">
        {(
          [
            ["uncommitted", "Uncommitted"],
            ["branch", "Branch"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`${id}-mode`}
              value={value}
              checked={mode.mode === value}
              onChange={() => update({ mode: value })}
              className="size-4 accent-primary"
            />
            {label}
          </label>
        ))}
      </div>
      {branchMode && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex items-center gap-2">
            Base
            <select
              aria-label="Base branch"
              value={base ?? ""}
              disabled={branches.isPending}
              onChange={(event) => update({ base: event.target.value })}
              className="h-8 min-w-0 rounded-md border bg-background px-2 text-base text-foreground md:text-sm"
            >
              {base === undefined && (
                <option value="" disabled>
                  Pick a branch
                </option>
              )}
              {base !== undefined && !options.includes(base) && (
                <option value={base}>{base}</option>
              )}
              {options.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={mode.uncommitted}
              onChange={(event) => update({ uncommitted: event.target.checked })}
              className="size-4 accent-primary"
            />
            Include uncommitted
          </label>
        </div>
      )}
    </div>
  );

  let body: ReactNode;
  if (branchMode && branches.isError) {
    body = (
      <LoadError
        what="the branches"
        error={branches.error}
        onRetry={() => void branches.refetch()}
      />
    );
  } else if (branchMode && base === undefined) {
    body = branches.isPending ? (
      <Loading />
    ) : (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Pick a base branch to compare with.
      </p>
    );
  } else if (diff.isPending) {
    body = <Loading />;
  } else if (diff.isError) {
    body = <LoadError what="the diff" error={diff.error} onRetry={() => void diff.refetch()} />;
  } else if (diff.data.files.length === 0) {
    body = (
      <p className="py-10 text-center text-sm text-muted-foreground">
        {branchMode ? `No changes against ${base}.` : "No changes. The working tree is clean."}
      </p>
    );
  } else {
    const response = diff.data;
    body = (
      <div className="flex flex-col gap-2">
        <Totals files={response.files} />
        <ul className="flex flex-col gap-2">
          {response.files.map((file) => (
            <FileRow
              key={`${file.oldPath ?? ""}:${file.path}`}
              file={file}
              toReference={(selection) => changeReference(file, response, selection)}
              {...(onAdded && { onAdded })}
            />
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {modeBar}
      {body}
    </div>
  );
}
