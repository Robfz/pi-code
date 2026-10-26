import type { AgentInfo, SidebarPatch } from "@pi-code/protocol";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ActivityIcon,
  ChevronRightIcon,
  GitBranchIcon,
  LoaderIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import { memo, type ReactNode, useCallback, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { StatusMark } from "@/components/agent-status";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { ProjectPicker } from "@/features/catalog/project-picker";
import { useOpenAgent } from "@/features/catalog/use-open-agent";
import { DismissButton, type SessionTarget } from "@/features/sessions/stop-or-delete";
import {
  ListingGroupIcon,
  type ListingGroupKind,
  MissingMark,
  NewWorktreeButton,
  RemoveWorktreeButton,
  worktreeSubgroupGuideClass,
} from "@/features/worktrees/worktree-actions";
import { agentStatus } from "@/lib/agent-status";
import { isLive } from "@/lib/agents";
import { errorMessage, restartAgent, searchSessions } from "@/lib/api";
import { queryKeys } from "@/lib/query-client";
import { formatRelative } from "@/lib/time";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { RELATIVE_TIME_TICK_MS, useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useLive, useLiveRegistry } from "@/store/context";
import {
  activeRows,
  allRows,
  buildSidebarGroups,
  checkoutLabel,
  hiddenMarks,
  liveBranch,
  type SidebarRow,
} from "./sidebar-model";

/** Delay before the search text queries `GET /api/sessions?q=`. */
export const SEARCH_DEBOUNCE_MS = 200;

const rowClass =
  "flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-1 pl-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-70";

/**
 * One conversation row. Memoised on value props: an agent frame, a catalog frame or the minute
 * tick re-renders only the rows they change.
 */
const Row = memo(function Row({
  title,
  agent,
  sessionFile,
  at,
  time,
  folder,
  project,
  current,
  pending,
  disabled,
  onOpen,
  onRestart,
  onSelect,
}: {
  title: string;
  /** Set on agent rows (exited agents included). */
  agent: AgentInfo | undefined;
  /** The session file to resume from this row. */
  sessionFile: string | undefined;
  /** The row's recency (epoch ms). */
  at: number;
  /** `at` as shown ("2m ago"). */
  time: string;
  /** The group's label, to tell apart same-titled rows in the `×`'s label. */
  folder: string;
  /** Shown after the title (Active rows). */
  project?: string | undefined;
  current: boolean;
  pending: boolean;
  /** Opening only; the `×` stays usable. */
  disabled: boolean;
  onOpen(sessionFile: string): void;
  onRestart(agent: AgentInfo): void;
  onSelect(): void;
}) {
  const content = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">
        <StatusMark status={agentStatus(agent, pending)} />
      </span>
      <span data-testid="sidebar-row-title" className="min-w-0 flex-1 truncate">
        {title}
      </span>
      {project !== undefined && (
        <span
          className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground"
          title={project}
        >
          {project}
        </span>
      )}
      <time
        dateTime={new Date(at).toISOString()}
        className="shrink-0 text-xs text-muted-foreground"
      >
        {time}
      </time>
    </>
  );
  // Live agents are navigated to; exited agents are restarted and sessions resumed, then shown.
  const live = agent !== undefined && isLive(agent);
  // Session rows are only for sessions no agent holds (`buildSidebarGroups`): the row's agent is
  // the holder.
  const target: SessionTarget | undefined = agent
    ? { agent }
    : sessionFile !== undefined
      ? { file: sessionFile }
      : undefined;
  return (
    <li
      data-testid="sidebar-row"
      className={cn(
        "flex min-w-0 items-center rounded-md text-subtle-foreground hover:bg-accent hover:text-foreground",
        current && "bg-sidebar-accent text-foreground hover:bg-sidebar-accent",
      )}
    >
      {live ? (
        <Link
          to="/agents/$agentId"
          params={{ agentId: agent.id }}
          aria-current={current ? "page" : undefined}
          className={rowClass}
          onClick={onSelect}
        >
          {content}
        </Link>
      ) : (
        <button
          type="button"
          disabled={disabled}
          aria-current={current ? "page" : undefined}
          className={rowClass}
          onClick={() => {
            if (agent) onRestart(agent);
            else if (sessionFile !== undefined) onOpen(sessionFile);
            onSelect();
          }}
        >
          {content}
        </button>
      )}
      {target && <DismissButton title={title} folder={folder} target={target} className="mr-1" />}
    </li>
  );
});

/** A collapsible group's state, and what its header shows of the rows it hides. */
interface Collapse {
  collapsed: boolean;
  onToggle(): void;
  hidden: readonly SidebarRow[];
}

function Group({
  label,
  path,
  kind,
  branch,
  missing = false,
  nested = false,
  collapse,
  actions,
  children,
}: {
  label: string;
  /** Shown as the label's tooltip. */
  path: string;
  kind: ListingGroupKind;
  branch?: string | undefined;
  missing?: boolean;
  /** A checkout inside a repo group. */
  nested?: boolean;
  /** Absent: the group can't collapse. */
  collapse?: Collapse | undefined;
  actions: ReactNode;
  children: ReactNode;
}) {
  const labelId = useId();
  const Heading = nested ? "h3" : "h2";
  const collapsed = collapse?.collapsed === true;
  const marks = collapsed ? hiddenMarks(collapse.hidden) : [];
  const title = (
    <>
      <ListingGroupIcon kind={kind} />
      <span
        id={labelId}
        className={cn(
          "min-w-0 truncate text-foreground/80",
          nested ? "font-normal" : "font-medium",
        )}
        title={path}
      >
        {label}
      </span>
      {branch !== undefined && (
        <span
          className="flex min-w-0 shrink-1000 items-center gap-0.5 overflow-hidden"
          title="Branch"
        >
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate font-mono">{branch}</span>
        </span>
      )}
      {missing && <MissingMark />}
      {marks.map((status) => (
        <span key={status} className="flex shrink-0 items-center">
          <StatusMark status={status} />
        </span>
      ))}
    </>
  );
  // The branch gives way first; the label truncates only once the branch is gone.
  const titleClass = "flex min-w-0 flex-1 items-center gap-2";
  return (
    <Collapsible
      open={!collapsed}
      onOpenChange={() => collapse?.onToggle()}
      role="group"
      aria-labelledby={labelId}
      className="flex flex-col gap-0.5"
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 pr-1 pb-0.5 pl-2 text-xs text-muted-foreground",
          nested ? "pt-1.5" : "pt-3",
        )}
      >
        <Heading className="flex min-w-0 flex-1">
          {collapse ? (
            // Only the title toggles: the actions beside it are buttons of their own.
            <CollapsibleTrigger
              className={cn(
                titleClass,
                "group/header cursor-pointer rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
              )}
            >
              {title}
              {/* Shown while collapsed, and on hover or focus while open. */}
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "size-[13px] shrink-0 text-faint-foreground transition-[opacity,transform] duration-150 group-data-[state=open]/header:rotate-90",
                  !collapsed &&
                    "opacity-0 group-hover/header:opacity-100 group-focus-visible/header:opacity-100",
                )}
              />
            </CollapsibleTrigger>
          ) : (
            <span className={titleClass}>{title}</span>
          )}
        </Heading>
        {actions}
      </div>
      {/* The 2px bleed keeps the rows' focus rings clear of the clip the animation needs. */}
      <CollapsibleContent className="-m-0.5 overflow-hidden p-0.5 duration-150 data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <div className="flex flex-col gap-0.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Every live agent under Active (`activeRows`), then conversations grouped by folder or repo
 * (`groupListing`), with search beside New conversation and Settings, per-folder `+`, Pin and New
 * worktree on repo groups, Remove worktree on linked ones and Stop or Delete on every row (`×`).
 * Group headers collapse, except the main checkout's; pins and collapsed groups are the server's
 * `sidebar` state. `action` sits alone in the titlebar row (the shell's toggle, the sheet's
 * close); `onSelect` runs whenever a row, `+`, Settings or a new conversation is picked. Docked
 * (`data-region="side"`), the titlebar row takes the chrome surface, so the title bar runs the
 * window's width: under Window Controls Overlay the traffic lights sit on it, on `theme-color`.
 */
export function Sidebar({ action, onSelect }: { action?: ReactNode; onSelect?: () => void }) {
  const { loaded, agents, sessions, branches, sidebar } = useLive(
    useShallow((s) => ({
      loaded: s.loaded,
      agents: s.agents,
      sessions: s.sessions,
      branches: s.branches,
      sidebar: s.sidebar,
    })),
  );
  const registry = useLiveRegistry();
  const currentId = useParams({ strict: false }).agentId;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const debounced = useDebouncedValue(trimmed, SEARCH_DEBOUNCE_MS);
  // Clearing the field shows every session at once; typing waits for the debounce.
  const query = trimmed === "" ? "" : debounced;
  const searching = query !== "";
  const search = useQuery({
    queryKey: queryKeys.sessionSearch(query),
    queryFn: () => searchSessions(query),
    enabled: searching,
    placeholderData: keepPreviousData,
  });
  const now = useNow(RELATIVE_TIME_TICK_MS);
  const searchRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const open = useOpenAgent();
  const restart = useMutation({
    mutationFn: (agentId: string) => restartAgent(agentId),
    onSuccess: (agent) => {
      void navigate({ to: "/agents/$agentId", params: { agentId: agent.id } });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });
  const busy = open.isPending || restart.isPending;
  const pending = open.isPending ? open.variables : undefined;
  const select = useCallback(() => onSelect?.(), [onSelect]);
  const openSession = useCallback(
    (sessionFile: string) => open.mutate({ sessionFile }),
    [open.mutate],
  );
  const restartRow = useCallback((agent: AgentInfo) => restart.mutate(agent.id), [restart.mutate]);

  const groups = useMemo(() => {
    const allAgents = Object.values(agents);
    const { pinned, mains } = sidebar;
    if (!searching) return buildSidebarGroups({ agents: allAgents, sessions, pinned, mains });
    const results = search.data ?? [];
    return buildSidebarGroups({
      agents: allAgents,
      sessions: results,
      known: [...sessions, ...results],
      query,
      pinned,
    });
  }, [agents, sessions, sidebar, searching, query, search.data]);
  const active = useMemo(() => activeRows(groups), [groups]);
  const activeLabelId = useId();

  const setSidebar = (patch: SidebarPatch) => {
    registry.setSidebar(patch).catch((error: unknown) => {
      toast.error(errorMessage(error));
    });
  };
  const collapsed = new Set(sidebar.collapsed);
  // Search shows every match: no group collapses until the field clears, the state untouched.
  const collapse = (path: string, hidden: readonly SidebarRow[]): Collapse | undefined =>
    searching
      ? undefined
      : {
          collapsed: collapsed.has(path),
          onToggle: () => setSidebar({ collapsed: { [path]: !collapsed.has(path) } }),
          hidden,
        };
  const pinned = new Set(sidebar.pinned);

  /** Pins or unpins a repo; filled while pinned. */
  const pin = (repo: string, name: string) => (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={`Pin ${name}`}
      aria-pressed={pinned.has(repo)}
      onClick={() => setSidebar({ pinned: { [repo]: !pinned.has(repo) } })}
    >
      <PinIcon className={cn(pinned.has(repo) && "fill-current")} />
    </Button>
  );

  /** `+`: a new conversation in `cwd`; `name` tells same-labelled folders apart. */
  const newHere = (cwd: string, name: string) => (
    <Button
      variant="ghost"
      size="icon-xs"
      disabled={busy}
      aria-label={`New conversation in ${name}`}
      onClick={() => {
        open.mutate({ cwd });
        select();
      }}
    >
      {pending !== undefined && "cwd" in pending && pending.cwd === cwd ? (
        <LoaderIcon className="animate-spin" />
      ) : (
        <PlusIcon />
      )}
    </Button>
  );

  /** One row; `disabled` blocks opening only (a `missing` folder's), every row deletes. */
  const rowItem = (row: SidebarRow, folder: string, disabled: boolean, project?: string) => (
    <Row
      key={row.key}
      title={row.title}
      agent={row.agent}
      sessionFile={row.sessionFile}
      at={row.recency.at}
      time={formatRelative(row.recency.at, now)}
      folder={folder}
      project={project}
      current={row.agent !== undefined && row.agent.id === currentId}
      pending={
        row.agent !== undefined
          ? restart.isPending && restart.variables === row.agent.id
          : pending !== undefined &&
            "sessionFile" in pending &&
            pending.sessionFile === row.sessionFile
      }
      disabled={busy || disabled}
      onOpen={openSession}
      onRestart={restartRow}
      onSelect={select}
    />
  );

  /** Rows of one folder; in a `missing` one only live agents open. */
  const rowList = (rows: SidebarRow[], folder: string, missing: boolean) => (
    <ul className="flex flex-col gap-0.5">{rows.map((row) => rowItem(row, folder, missing))}</ul>
  );

  return (
    <nav aria-label="Conversations" className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-3 border-b pb-4">
        <div className="titlebar flex items-center gap-1 px-4 pt-4 [--titlebar-pad:1rem] in-data-[region=side]:bg-surface-chrome">
          {action}
        </div>
        <div className="mx-4 flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={searchRef}
              type="search"
              aria-label="Search conversations"
              placeholder="Search…"
              value={text}
              onChange={(event) => setText(event.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="pr-8 pl-8 [&::-webkit-search-cancel-button]:appearance-none"
            />
            {text !== "" && (
              <Button
                variant="ghost"
                size="icon-xs"
                className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
                aria-label="Clear search"
                onClick={() => {
                  setText("");
                  searchRef.current?.focus();
                }}
              >
                <XIcon />
              </Button>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="New conversation"
            title="New conversation"
            onClick={() => setPickerOpen(true)}
          >
            <PlusIcon />
          </Button>
          <Button variant="ghost" size="icon" asChild>
            <Link to="/settings" aria-label="Settings" title="Settings" onClick={select}>
              <SettingsIcon />
            </Link>
          </Button>
        </div>
      </div>
      <ProjectPicker open={pickerOpen} onOpenChange={setPickerOpen} onOpened={select} />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[max(1rem,env(safe-area-inset-bottom))] [scrollbar-gutter:stable]">
        {!loaded && (
          <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin" /> Loading…
          </p>
        )}
        {searching && search.isPending && (
          <p className="flex items-center gap-2 px-3 pt-3 text-xs text-muted-foreground">
            <LoaderIcon className="size-3.5 animate-spin" /> Searching…
          </p>
        )}
        {searching && search.isError && (
          <p role="alert" className="px-3 pt-3 text-xs text-destructive">
            {errorMessage(search.error)}
          </p>
        )}
        {loaded && groups.length === 0 && !(searching && (search.isPending || search.isError)) && (
          <p className="p-3 text-sm text-muted-foreground">
            {searching ? "No matches." : "No conversations yet."}
          </p>
        )}
        {active.length > 0 && (
          // biome-ignore lint/a11y/useSemanticElements: a list of rows, not a form <fieldset>
          <div role="group" aria-labelledby={activeLabelId} className="flex flex-col gap-0.5">
            <div className="pt-3 pr-1 pb-0.5 pl-2 text-xs text-muted-foreground">
              <h2 className="flex min-h-6 items-center gap-2">
                <ActivityIcon aria-hidden className="size-3.5 shrink-0" />
                <span id={activeLabelId} className="font-medium text-foreground/80">
                  Active
                </span>
              </h2>
            </div>
            <ul className="flex flex-col gap-0.5">
              {active.map((row) => rowItem(row, row.project, false, row.project))}
            </ul>
          </div>
        )}
        {groups.map((group) =>
          group.kind === "folder" ? (
            <Group
              key={`folder:${group.cwd}`}
              kind="folder"
              label={group.label}
              path={group.cwd}
              branch={liveBranch(branches, group.cwd, group.items)}
              // A missing folder keeps no state (it would be pruned at once).
              collapse={group.missing ? undefined : collapse(group.cwd, group.items)}
              actions={newHere(group.cwd, group.label)}
            >
              {rowList(group.items, group.label, false)}
            </Group>
          ) : (
            <Group
              key={`repo:${group.repo}`}
              kind="repo"
              label={group.label}
              path={group.repo}
              collapse={collapse(group.repo, allRows(group))}
              actions={
                <>
                  {pin(group.repo, group.label)}
                  <NewWorktreeButton
                    compact
                    repo={{ path: group.repo, label: group.label }}
                    onOpened={select}
                  />
                  {newHere(group.repo, group.label)}
                </>
              }
            >
              {group.items.length > 0 && rowList(group.items, group.label, false)}
              {group.worktrees.length > 0 && (
                <div className={cn(worktreeSubgroupGuideClass, "gap-0.5")}>
                  {group.worktrees.map((worktree) => {
                    const name = checkoutLabel(group.label, worktree.label);
                    return (
                      <Group
                        key={worktree.cwd}
                        kind="worktree"
                        nested
                        label={worktree.label}
                        path={worktree.cwd}
                        branch={liveBranch(branches, worktree.cwd, worktree.items)}
                        missing={worktree.missing}
                        // A missing folder keeps no state (it would be pruned at once).
                        collapse={
                          worktree.role === "worktree" && !worktree.missing
                            ? collapse(worktree.cwd, worktree.items)
                            : undefined
                        }
                        actions={
                          <>
                            {!worktree.missing && newHere(worktree.cwd, name)}
                            {worktree.role === "worktree" && (
                              <RemoveWorktreeButton
                                compact
                                target={{ path: worktree.cwd, label: worktree.label }}
                                name={name}
                              />
                            )}
                          </>
                        }
                      >
                        {rowList(worktree.items, name, worktree.missing)}
                      </Group>
                    );
                  })}
                </div>
              )}
            </Group>
          ),
        )}
      </div>
    </nav>
  );
}
