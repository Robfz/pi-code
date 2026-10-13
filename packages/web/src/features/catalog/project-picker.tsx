import {
  type AgentInfo,
  type DirSuggestion,
  type ProjectSummary,
  recencyOf,
} from "@pi-code/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightIcon,
  FolderGit2Icon,
  FolderIcon,
  GitForkIcon,
  HistoryIcon,
  LoaderIcon,
  PlusIcon,
} from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  sheetCenteredOnDesktop,
} from "@/components/ui/sheet";
import {
  MissingMark,
  NewWorktreeButton,
  worktreeSubgroupGuideClass,
} from "@/features/worktrees/worktree-actions";
import { errorMessage, listDirs, listProjects } from "@/lib/api";
import { baseName } from "@/lib/content";
import { queryKeys } from "@/lib/query-client";
import { formatRelative } from "@/lib/time";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { cn } from "@/lib/utils";
import { groupListing } from "./listing-groups";
import { useOpenAgent } from "./use-open-agent";

/** Delay before the path field queries `/api/fs/dirs`. */
export const AUTOCOMPLETE_DEBOUNCE_MS = 250;

/** Strip trailing slashes (keeping a lone "/"). */
function normalize(path: string): string {
  const trimmed = path.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") || "/" : trimmed;
}

function dirName(path: string): string {
  const index = path.replace(/\/+$/, "").lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

/**
 * `POST /api/agents` needs an absolute path; `~` only works for `/api/fs/dirs`. Resolve a
 * `~`-prefixed path through the autocomplete: an exact match, or the parent of any child.
 */
async function resolvePath(
  path: string,
  fetchDirs: (prefix: string) => Promise<DirSuggestion[]>,
): Promise<string> {
  if (!path.startsWith("~")) return path;
  const rest = path.slice(1); // "" or "/…"
  if (rest !== "") {
    const exact = (await fetchDirs(path)).find((d) => normalize(d.path).endsWith(rest));
    if (exact) return normalize(exact.path);
  }
  const child = (await fetchDirs(`${path}/`))[0];
  if (child) return dirName(normalize(child.path));
  throw new Error(`Can't resolve ${path} — pick a folder from the suggestions.`);
}

/** A layout repo in the recent projects: header with "New worktree", then its folders' rows. */
function RepoGroup({
  label,
  path,
  onOpened,
  children,
}: {
  label: string;
  path: string;
  /** Runs with the new worktree's agent. */
  onOpened(agent: AgentInfo): void;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a repo's folders, not a form <fieldset>
    <div role="group" aria-labelledby={headingId} className="flex flex-col">
      <div className="flex min-w-0 items-center gap-2 px-2 pt-2 text-xs text-muted-foreground">
        <FolderGit2Icon aria-hidden className="size-3.5 shrink-0" />
        <h4 id={headingId} title={path} className="min-w-0 truncate font-medium text-foreground/80">
          {label}
        </h4>
        <div className="ml-auto">
          <NewWorktreeButton repo={{ path, label }} onOpened={onOpened} />
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * "New conversation": recent projects (in listing groups, with "New worktree" on layout repos)
 * plus a path field with debounced autocomplete under `$HOME`, then `POST /api/agents { cwd }`,
 * close and navigate to the new agent.
 */
export function ProjectPicker({
  open,
  onOpenChange,
  title = "New conversation",
  onOpened,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title?: string;
  /** Runs with the new agent before navigating to it. */
  onOpened?: (agent: AgentInfo) => void;
}) {
  const queryClient = useQueryClient();
  const opened = (agent: AgentInfo) => {
    onOpened?.(agent);
    onOpenChange(false);
  };
  const openAgent = useOpenAgent({ toastErrors: false, onOpened: opened });
  const [path, setPath] = useState("");
  const [resolveError, setResolveError] = useState<string | null>(null);
  const prefix = useDebouncedValue(
    path.trim() === "" ? "~/" : path.trim(),
    AUTOCOMPLETE_DEBOUNCE_MS,
  );

  const projects = useQuery({
    queryKey: queryKeys.projects,
    queryFn: listProjects,
    enabled: open,
  });
  const dirs = useQuery({
    queryKey: queryKeys.dirs(prefix),
    queryFn: () => listDirs(prefix),
    enabled: open,
    staleTime: 30_000,
    retry: false,
    placeholderData: (previous) => previous,
  });

  const fetchDirs = (p: string) =>
    queryClient.fetchQuery({
      queryKey: queryKeys.dirs(p),
      queryFn: () => listDirs(p),
      staleTime: 30_000,
    });

  async function start(target: string) {
    const normalized = normalize(target);
    if (normalized === "") return;
    setResolveError(null);
    try {
      const cwd = await resolvePath(normalized, fetchDirs);
      openAgent.mutate({ cwd });
    } catch (error) {
      setResolveError(errorMessage(error));
    }
  }

  const busy = openAgent.isPending;
  const suggestions = dirs.data ?? [];
  const groups = useMemo(
    () =>
      groupListing(projects.data ?? [], {
        cwd: (project) => project.cwd,
        layout: (project) => project.layout,
        recency: (project) => recencyOf(project),
      }),
    [projects.data],
  );
  const projectRow = (
    project: ProjectSummary,
    label: string,
    { icon, missing = false }: { icon?: ReactNode; missing?: boolean } = {},
  ) => (
    <li key={project.cwd}>
      <button
        type="button"
        disabled={busy || missing}
        onClick={() => openAgent.mutate({ cwd: project.cwd })}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/60 disabled:opacity-60"
      >
        {icon ??
          (project.isGitRepo ? (
            <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
          ))}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{label}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{project.cwd}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {missing && <MissingMark />}
          {missing && " · "}
          {project.sessionCount} · {formatRelative(recencyOf(project).at)}
        </span>
      </button>
    </li>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        data-testid="project-picker"
        className={cn(
          "max-h-[90dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)] lg:max-w-2xl",
          sheetCenteredOnDesktop,
        )}
      >
        <SheetHeader className="pr-12">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>Pick a project folder under your home directory.</SheetDescription>
        </SheetHeader>
        <form
          className="flex gap-2 px-4"
          onSubmit={(event) => {
            event.preventDefault();
            void start(path);
          }}
        >
          <Input
            aria-label="Folder path"
            value={path}
            onChange={(event) => {
              setPath(event.target.value);
              setResolveError(null);
              openAgent.reset();
            }}
            placeholder="~/code/project"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            className="h-10 font-mono text-base md:text-sm"
          />
          <Button type="submit" className="h-10" disabled={busy || path.trim() === ""}>
            {busy ? <LoaderIcon className="animate-spin" /> : <PlusIcon />}
            Start
          </Button>
        </form>
        {(() => {
          const message =
            resolveError ??
            (openAgent.error ? errorMessage(openAgent.error) : null) ??
            (dirs.isError ? errorMessage(dirs.error) : null);
          return message ? (
            <p role="alert" className="px-4 text-sm text-destructive">
              {message}
            </p>
          ) : null;
        })()}
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pb-4 [scrollbar-gutter:stable]">
          {suggestions.length > 0 && (
            <ul aria-label="Folder suggestions" className="flex flex-col">
              {suggestions.map((dir) => (
                <li key={dir.path} className="flex items-center gap-1">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/60"
                    onClick={() => {
                      setPath(`${normalize(dir.path)}/`);
                      setResolveError(null);
                    }}
                  >
                    {dir.isGitRepo ? (
                      <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm">{baseName(dir.path)}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {dir.path}
                      </span>
                    </span>
                    {dir.hasSessions && (
                      <Badge variant="secondary" className="ml-auto">
                        sessions
                      </Badge>
                    )}
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    aria-label={`Start in ${baseName(dir.path)}`}
                    onClick={() => openAgent.mutate({ cwd: normalize(dir.path) })}
                  >
                    <ArrowRightIcon />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <section className="flex flex-col gap-1">
            <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <HistoryIcon className="size-3.5" /> Recent projects
            </h3>
            {projects.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
            {projects.isError && (
              <p className="text-sm text-destructive">{errorMessage(projects.error)}</p>
            )}
            {projects.data?.length === 0 && (
              <p className="text-sm text-muted-foreground">No projects yet.</p>
            )}
            {groups.length > 0 && (
              <ul aria-label="Recent projects" className="flex flex-col">
                {groups.map((group) =>
                  group.kind === "folder" ? (
                    group.items.map((project) => projectRow(project, group.label))
                  ) : (
                    <li key={`repo:${group.repo}`}>
                      <RepoGroup label={group.label} path={group.repo} onOpened={opened}>
                        <ul className="flex flex-col">
                          {group.items.map((project) => projectRow(project, group.label))}
                        </ul>
                        {group.worktrees.some((w) => w.items.length > 0) && (
                          <ul className={worktreeSubgroupGuideClass}>
                            {group.worktrees.flatMap((worktree) =>
                              worktree.items.map((project) =>
                                projectRow(project, worktree.label, {
                                  icon: (
                                    <GitForkIcon
                                      aria-hidden
                                      className="size-4 shrink-0 text-muted-foreground"
                                    />
                                  ),
                                  missing: worktree.missing,
                                }),
                              ),
                            )}
                          </ul>
                        )}
                      </RepoGroup>
                    </li>
                  ),
                )}
              </ul>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
