/**
 * The Changes tab (`docs/design/07-code-review.md`, "Changes tab"): the git diff of the agent's
 * project in uncommitted or branch mode, or of the attached PR (`docs/design/10-pr-review.md`), as
 * a toolbar, a compact file list and every file's patch under a sticky header. Patch lines send
 * references to the composer, versioned per "Version naming".
 */

import type { CodeRef, GitDiffResponse, GitFileDiff, PrGuideNoHunks } from "@pi-code/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheckIcon,
  GitBranchIcon,
  GitCompareIcon,
  GitPullRequestIcon,
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
import { BranchPicker } from "./branch-picker";
import {
  changeReference,
  EXPAND_MAX_FILES,
  EXPAND_MAX_LINES,
  FileCard,
  FilePath,
  LineCounts,
  NoHunks,
  StatusBadge,
} from "./file-card";
import { useConversationPr } from "./pr";
import { PrHeader } from "./pr-header";
import { LoadError, NotARepo, retryServerErrors } from "./query-states";
import {
  type DiffMode,
  type DiffModeName,
  diffModeOf,
  useReview,
  useReviewStore,
} from "./review-state";
import { SelectableDiff } from "./selectable-diff";

interface FileEntry {
  key: string;
  file: GitFileDiff;
  counts?: { additions: number; deletions: number };
}

function Counts({ entry: { file, counts } }: { entry: FileEntry }) {
  const noHunks: PrGuideNoHunks | undefined = file.binary
    ? "binary"
    : file.tooLarge
      ? "tooLarge"
      : undefined;
  if (noHunks) return <NoHunks reason={noHunks} />;
  if (!counts) return null;
  return <LineCounts {...counts} />;
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

/** One file's patch under its sticky header. */
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
  return (
    <FileCard
      file={entry.file}
      aside={<Counts entry={entry} />}
      open={open}
      onOpenChange={onOpenChange}
      cardRef={sectionRef}
      className="border-b"
    >
      <FileBody file={entry.file} toReference={toReference} {...(onAdded && { onAdded })} />
    </FileCard>
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
  pinned,
  expand,
  onAdded,
}: {
  entries: FileEntry[];
  response: GitDiffResponse;
  /** The new side is a commit that isn't on disk (PR mode). */
  pinned: boolean;
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
          toReference={(selection) => changeReference(entry.file, response, selection, pinned)}
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
  ["pr", "PR"],
] as const;

/** Uncommitted / Branch, and PR when attached, as a segmented control: one item is always on. */
function ModeControl({
  value,
  attached,
  onChange,
}: {
  value: DiffModeName;
  attached: boolean;
  onChange(mode: DiffModeName): void;
}) {
  return (
    <ToggleGroup
      type="single"
      aria-label="Diff mode"
      value={value}
      onValueChange={(next) => next && onChange(next as DiffModeName)}
      spacing={0.5}
      className="rounded-lg bg-chip p-0.5"
    >
      {MODES.filter(([mode]) => attached || mode !== "pr").map(([mode, label]) => (
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
  const pr = useConversationPr();
  const modeName = diffModeOf(mode, pr !== undefined);
  const branchMode = modeName === "branch";
  const prMode = modeName === "pr" ? pr : undefined;
  const switchId = useId();

  const branches = useQuery({
    ...branchesQuery(agentId),
    enabled: branchMode,
  });
  const base = mode.base ?? branches.data?.defaultBranch ?? undefined;
  const diff = useQuery({
    queryKey: prMode
      ? queryKeys.prDiff(agentId, prMode.baseSha, prMode.headSha)
      : branchMode
        ? queryKeys.gitDiff(agentId, "branch", base, mode.uncommitted)
        : queryKeys.gitDiff(agentId, "uncommitted"),
    queryFn: ({ client, queryKey }) =>
      getGitDiff(
        agentId,
        prMode ? { pr: true } : branchMode ? { base, uncommitted: mode.uncommitted } : {},
        client.getQueryData(queryKey),
      ),
    enabled: !branchMode || base !== undefined,
    staleTime: prMode ? Number.POSITIVE_INFINITY : 0,
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
      <ModeControl
        value={modeName}
        attached={pr !== undefined}
        onChange={(next) => update({ mode: next })}
      />
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
    body = prMode ? (
      <EmptyState icon={<GitPullRequestIcon />} title="No changes in this PR" />
    ) : branchMode ? (
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
        key={prMode ? `pr:${prMode.headSha}` : `${modeName}:${base}:${mode.uncommitted}`}
        entries={entries}
        response={diff.data}
        pinned={prMode !== undefined}
        expand={expand}
        {...(onAdded && { onAdded })}
      />
    );
  }

  return (
    <div className="flex flex-col">
      {toolbar}
      {prMode && <PrHeader agentId={agentId} pr={prMode} />}
      {branchMode && fetching.isError && (
        <p role="alert" className="border-b px-3 py-1.5 text-xs text-destructive">
          Couldn't fetch: {errorMessage(fetching.error)}
        </p>
      )}
      {body}
    </div>
  );
}
