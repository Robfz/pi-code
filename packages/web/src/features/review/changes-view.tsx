/**
 * The Changes tab (`docs/design/07-code-review.md`, "Changes tab"): the git diff of the agent's
 * project in uncommitted or branch mode, as a toolbar, a compact file list and every file's patch
 * under a sticky header. Patch lines send references to the composer, versioned per "Version
 * naming".
 */

import type { CodeRef, GitDiffResponse, GitFileDiff } from "@pi-code/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRightIcon,
  CircleCheckIcon,
  GitBranchIcon,
  GitCompareIcon,
  LoaderIcon,
  RefreshCwIcon,
} from "lucide-react";
import { type ReactNode, useId, useMemo, useRef, useState } from "react";
import { countPatchLines, type LineSelection } from "@/components/diff";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  errorMessage,
  fetchOrigin,
  getGitBranches,
  getGitDiff,
  isApiRequestError,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { BranchPicker } from "./branch-picker";
import { splitPath } from "./files-view";
import { LoadError, NotARepo, retryServerErrors } from "./query-states";
import { type DiffMode, useReview, useReviewStore } from "./review-state";
import { SelectableDiff } from "./selectable-diff";

const STATUS: Record<GitFileDiff["status"], { letter: string; label: string; className: string }> =
  {
    added: { letter: "A", label: "Added", className: "bg-diff-add/12 text-diff-add" },
    untracked: { letter: "U", label: "Untracked", className: "bg-diff-add/12 text-diff-add" },
    modified: {
      letter: "M",
      label: "Modified",
      className: "bg-status-input/12 text-status-input",
    },
    deleted: { letter: "D", label: "Deleted", className: "bg-diff-del/12 text-diff-del" },
    renamed: { letter: "R", label: "Renamed", className: "bg-muted text-muted-foreground" },
  };

/**
 * Every expanded file mounts a diff view, so past these totals (files, or added plus deleted
 * lines) the files start collapsed and open from the list or their header.
 */
export const EXPAND_MAX_FILES = 30;
export const EXPAND_MAX_LINES = 3000;

interface FileEntry {
  key: string;
  file: GitFileDiff;
  counts?: { additions: number; deletions: number };
}

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

function StatusBadge({ status }: { status: GitFileDiff["status"] }) {
  const { letter, label, className } = STATUS[status] ?? STATUS.modified;
  return (
    <span
      title={label}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] font-mono text-[10px] leading-none font-semibold",
        className,
      )}
    >
      <span aria-hidden>{letter}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** The directory muted and the basename in front; the basename is the last to truncate. */
function FilePath({ file }: { file: GitFileDiff }) {
  const { dir, name } = splitPath(file.path);
  const renamed = file.oldPath !== undefined && file.oldPath !== file.path;
  return (
    <span
      title={renamed ? `${file.oldPath} → ${file.path}` : file.path}
      className="flex min-w-0 flex-1 font-mono text-xs"
    >
      {renamed && (
        <>
          <span className="min-w-0 truncate text-muted-foreground">{file.oldPath}</span>
          <span aria-hidden className="shrink-0 px-1 text-faint-foreground">
            →
          </span>
        </>
      )}
      {dir && <span className="min-w-0 truncate text-muted-foreground">{dir}/</span>}
      <span className="max-w-full shrink-0 truncate">{name}</span>
    </span>
  );
}

function Counts({ entry: { file, counts } }: { entry: FileEntry }) {
  if (file.binary) return <span className="shrink-0 text-xs text-muted-foreground">binary</span>;
  if (file.tooLarge) {
    return <span className="shrink-0 text-xs text-muted-foreground">too large</span>;
  }
  if (!counts) return null;
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className="text-diff-add">+{counts.additions}</span>{" "}
      <span className="text-diff-del">−{counts.deletions}</span>
    </span>
  );
}

function FileBody({
  file,
  toReference,
  onAdded,
}: {
  file: GitFileDiff;
  toReference(selection: LineSelection): CodeRef;
  onAdded?(): void;
}) {
  const message = (text: string) => (
    <p className="px-3 py-2 text-xs text-muted-foreground">{text}</p>
  );
  if (file.binary) return message("Binary file, no text diff.");
  if (file.tooLarge) return message("This diff is too large to show here (over 1 MB).");
  if (!file.patch) return message("No textual changes.");
  return (
    <SelectableDiff
      patch={file.patch}
      fileName={file.path}
      flush
      toReference={toReference}
      {...(onAdded && { onAdded })}
    />
  );
}

/** One file's patch under a header that sticks to the top of the panel's scroll area. */
function FileSection({
  entry,
  open,
  onOpenChange,
  sectionRef,
  toReference,
  onAdded,
}: {
  entry: FileEntry;
  open: boolean;
  onOpenChange(open: boolean): void;
  sectionRef(element: HTMLElement | null): void;
  toReference(selection: LineSelection): CodeRef;
  onAdded?(): void;
}) {
  const section = useRef<HTMLElement | null>(null);
  const header = useRef<HTMLDivElement>(null);
  const toggle = () => {
    // Collapsing a file whose header is stuck would leave the view somewhere past it.
    const top = section.current?.getBoundingClientRect().top;
    const headerTop = header.current?.getBoundingClientRect().top;
    if (open && top !== undefined && headerTop !== undefined && headerTop > top) {
      section.current?.scrollIntoView({ block: "start" });
    }
    onOpenChange(!open);
  };
  return (
    <section
      ref={(element) => {
        section.current = element;
        sectionRef(element);
      }}
      data-testid="diff-file"
      data-path={entry.file.path}
      className="border-b"
    >
      <div
        ref={header}
        className={cn(
          "sticky top-0 z-20 flex h-9 items-center gap-2 bg-background pr-3 pl-2 in-data-[region=side]:bg-surface-side",
          open && "border-b",
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRightIcon
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <StatusBadge status={entry.file.status} />
          <FilePath file={entry.file} />
        </button>
        <Counts entry={entry} />
      </div>
      {open && (
        <FileBody file={entry.file} toReference={toReference} {...(onAdded && { onAdded })} />
      )}
    </section>
  );
}

/** The list of changed files above the patches; a click scrolls to the file's patch. */
function FileList({ entries, onPick }: { entries: FileEntry[]; onPick(key: string): void }) {
  return (
    <nav aria-label="Changed files" className="border-b px-1.5 py-1.5">
      <ul>
        {entries.map((entry) => (
          <li key={entry.key}>
            <button
              type="button"
              onClick={() => onPick(entry.key)}
              className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <StatusBadge status={entry.file.status} />
              <FilePath file={entry.file} />
              <Counts entry={entry} />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function FileStack({
  entries,
  response,
  expand,
  onAdded,
}: {
  entries: FileEntry[];
  response: GitDiffResponse;
  /** Whether files start expanded. */
  expand: boolean;
  onAdded?(): void;
}) {
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const sections = useRef(new Map<string, HTMLElement>());
  const isOpen = (key: string) => opened[key] ?? expand;
  const setOpen = (key: string, open: boolean) =>
    setOpened((current) => ({ ...current, [key]: open }));
  return (
    <>
      {entries.length > 1 && (
        <FileList
          entries={entries}
          onPick={(key) => {
            setOpen(key, true);
            sections.current.get(key)?.scrollIntoView({ block: "start" });
          }}
        />
      )}
      {entries.map((entry) => (
        <FileSection
          key={entry.key}
          entry={entry}
          open={isOpen(entry.key)}
          onOpenChange={(open) => setOpen(entry.key, open)}
          sectionRef={(element) => {
            if (element) sections.current.set(entry.key, element);
            else sections.current.delete(entry.key);
          }}
          toReference={(selection) => changeReference(entry.file, response, selection)}
          {...(onAdded && { onAdded })}
        />
      ))}
    </>
  );
}

function Totals({ entries }: { entries: FileEntry[] }) {
  const { additions, deletions } = sumCounts(entries);
  return (
    <p className="ml-auto flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums">
      <span className="text-muted-foreground">
        {entries.length} {entries.length === 1 ? "file" : "files"}
      </span>
      <span>
        <span className="text-diff-add">+{additions}</span>{" "}
        <span className="text-diff-del">−{deletions}</span>
      </span>
    </p>
  );
}

function sumCounts(entries: FileEntry[]) {
  let additions = 0;
  let deletions = 0;
  for (const { counts } of entries) {
    additions += counts?.additions ?? 0;
    deletions += counts?.deletions ?? 0;
  }
  return { additions, deletions };
}

function Loading() {
  return (
    <div data-testid="diff-loading" className="flex flex-col gap-2 p-3">
      <Skeleton className="h-7" />
      <Skeleton className="h-7" />
      <Skeleton className="h-7" />
    </div>
  );
}

function branchesQuery(agentId: string) {
  return {
    queryKey: queryKeys.gitBranches(agentId),
    queryFn: () => getGitBranches(agentId),
    refetchOnWindowFocus: false,
    retry: retryServerErrors,
  };
}

/** The clean tree's way into branch mode, naming the base it will compare with once known. */
function CompareButton({
  agentId,
  base,
  onClick,
}: {
  agentId: string;
  base: string | undefined;
  onClick(): void;
}) {
  const branches = useQuery(branchesQuery(agentId));
  const target = base ?? branches.data?.defaultBranch;
  return (
    <Button size="sm" variant="outline" onClick={onClick}>
      <GitCompareIcon />
      {target ? `Compare with ${target}` : "Compare with branch"}
    </Button>
  );
}

const MODES = [
  ["uncommitted", "Uncommitted"],
  ["branch", "Branch"],
] as const;

/** Uncommitted / Branch as a segmented control: one item is always on. */
function ModeControl({
  value,
  onChange,
}: {
  value: DiffMode["mode"];
  onChange(mode: DiffMode["mode"]): void;
}) {
  return (
    <ToggleGroup
      type="single"
      aria-label="Diff mode"
      value={value}
      onValueChange={(next) => next && onChange(next as DiffMode["mode"])}
      spacing={0.5}
      className="rounded-lg bg-chip p-0.5"
    >
      {MODES.map(([mode, label]) => (
        <ToggleGroupItem
          key={mode}
          value={mode}
          className="h-6 min-w-0 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-popover data-[state=on]:text-foreground data-[state=on]:shadow-[0_0_0_1px_var(--input),0_1px_2px_oklch(0_0_0/0.2)] dark:data-[state=on]:bg-secondary"
        >
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function ChangesView({ agentId, onAdded }: { agentId: string; onAdded?(): void }) {
  const { diff: mode } = useReview(agentId);
  const branchMode = mode.mode === "branch";
  const switchId = useId();

  const branches = useQuery({
    ...branchesQuery(agentId),
    enabled: branchMode,
  });
  const base = mode.base ?? branches.data?.defaultBranch ?? undefined;
  const diff = useQuery({
    queryKey: branchMode
      ? queryKeys.gitDiff(agentId, "branch", base, mode.uncommitted)
      : queryKeys.gitDiff(agentId, "uncommitted"),
    queryFn: ({ client, queryKey }) =>
      getGitDiff(
        agentId,
        branchMode ? { base, uncommitted: mode.uncommitted } : {},
        client.getQueryData(queryKey),
      ),
    enabled: !branchMode || base !== undefined,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: retryServerErrors,
  });

  const entries = useMemo(
    () =>
      diff.data?.files.map(
        (file): FileEntry => ({
          key: `${file.oldPath ?? ""}:${file.path}`,
          file,
          ...(file.patch && { counts: countPatchLines(file.patch) }),
        }),
      ),
    [diff.data],
  );

  const queryClient = useQueryClient();
  const fetching = useMutation({
    mutationFn: () => fetchOrigin(agentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitDiffs(agentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitBranches(agentId) });
    },
  });

  const update = (change: Partial<DiffMode>) =>
    useReviewStore.getState().setDiffMode(agentId, change);

  if (
    isApiRequestError(diff.error, "not_a_git_repo") ||
    isApiRequestError(branches.error, "not_a_git_repo")
  ) {
    return <NotARepo />;
  }

  const showDiff = !(branchMode && (branches.isError || base === undefined));
  const toolbar = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2">
      <ModeControl value={mode.mode} onChange={(next) => update({ mode: next })} />
      {branchMode && (
        <>
          <BranchPicker
            value={base}
            branches={branches.data?.branches ?? []}
            disabled={branches.isPending}
            onChange={(branch) => update({ base: branch })}
          />
          <div className="flex items-center gap-1.5">
            <Switch
              id={switchId}
              size="sm"
              checked={mode.uncommitted}
              onCheckedChange={(checked) => update({ uncommitted: checked })}
            />
            <label htmlFor={switchId} className="text-xs whitespace-nowrap text-muted-foreground">
              Include uncommitted
            </label>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={fetching.isPending}
            onClick={() => fetching.mutate()}
            className="text-muted-foreground"
          >
            {fetching.isPending ? <LoaderIcon className="animate-spin" /> : <RefreshCwIcon />}
            Fetch
          </Button>
        </>
      )}
      {showDiff && entries && entries.length > 0 && <Totals entries={entries} />}
    </div>
  );

  let body: ReactNode;
  if (branchMode && branches.isError) {
    body = (
      <div className="p-3">
        <LoadError
          what="the branches"
          error={branches.error}
          onRetry={() => void branches.refetch()}
        />
      </div>
    );
  } else if (branchMode && base === undefined) {
    body = branches.isPending ? (
      <Loading />
    ) : (
      <EmptyState icon={<GitBranchIcon />} title="Pick a base branch to compare with." />
    );
  } else if (diff.isPending) {
    body = <Loading />;
  } else if (diff.isError) {
    body = (
      <div className="p-3">
        <LoadError what="the diff" error={diff.error} onRetry={() => void diff.refetch()} />
      </div>
    );
  } else if (!entries || entries.length === 0) {
    body = branchMode ? (
      <EmptyState icon={<GitCompareIcon />} title={`No changes against ${base}`} />
    ) : (
      <EmptyState
        icon={<CircleCheckIcon />}
        title="No changes"
        description="The working tree is clean."
        action={
          <CompareButton
            agentId={agentId}
            base={mode.base}
            onClick={() => update({ mode: "branch" })}
          />
        }
      />
    );
  } else {
    const { additions, deletions } = sumCounts(entries);
    const expand = entries.length <= EXPAND_MAX_FILES && additions + deletions <= EXPAND_MAX_LINES;
    body = (
      <FileStack
        key={`${mode.mode}:${base}:${mode.uncommitted}`}
        entries={entries}
        response={diff.data}
        expand={expand}
        {...(onAdded && { onAdded })}
      />
    );
  }

  return (
    <div className="flex flex-col">
      {toolbar}
      {branchMode && fetching.isError && (
        <p role="alert" className="border-b px-3 py-1.5 text-xs text-destructive">
          Couldn't fetch: {errorMessage(fetching.error)}
        </p>
      )}
      {body}
    </div>
  );
}
