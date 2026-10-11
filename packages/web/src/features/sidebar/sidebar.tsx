import type { AgentInfo } from "@pi-code/protocol";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { GitBranchIcon, LoaderIcon, PlusIcon, SearchIcon, SettingsIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { StatusMark } from "@/components/agent-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProjectPicker } from "@/features/catalog/project-picker";
import { useOpenAgent } from "@/features/catalog/use-open-agent";
import { StopOrDeleteButton } from "@/features/sessions/stop-or-delete";
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
import { cn } from "@/lib/utils";
import { useLive } from "@/store/context";
import { buildSidebarGroups, liveBranch, type SidebarRow } from "./sidebar-model";

/** Delay before the search text queries `GET /api/sessions?q=`. */
export const SEARCH_DEBOUNCE_MS = 200;

/** How often relative times ("2m ago") are refreshed. */
export const RELATIVE_TIME_TICK_MS = 60_000;

/** `Date.now()`, refreshed every `intervalMs`. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const rowClass =
  "flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-1 pl-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-70";

function Row({
  row,
  folder,
  now,
  current,
  pending,
  disabled,
  onOpen,
  onRestart,
  onSelect,
}: {
  row: SidebarRow;
  /** The group's label, to tell apart same-titled rows in the `×`'s label. */
  folder: string;
  now: number;
  current: boolean;
  pending: boolean;
  /** Opening only; the `×` stays usable. */
  disabled: boolean;
  onOpen(sessionFile: string): void;
  onRestart(agent: AgentInfo): void;
  onSelect(): void;
}) {
  const agent = row.agent;
  const content = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">
        <StatusMark status={agentStatus(agent, pending)} />
      </span>
      <span data-testid="sidebar-row-title" className="min-w-0 flex-1 truncate">
        {row.title}
      </span>
      <time
        dateTime={new Date(row.activity).toISOString()}
        className="shrink-0 text-xs text-muted-foreground"
      >
        {formatRelative(new Date(row.activity).toISOString(), now)}
      </time>
    </>
  );
  // Live agents are navigated to; exited agents are restarted and sessions resumed, then shown.
  const live = agent !== undefined && isLive(agent);
  return (
    <li
      data-testid="sidebar-row"
      className={cn(
        "flex min-w-0 items-center rounded-md hover:bg-muted/60",
        current && "bg-muted font-medium",
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
            else if (row.sessionFile !== undefined) onOpen(row.sessionFile);
            onSelect();
          }}
        >
          {content}
        </button>
      )}
      <StopOrDeleteButton
        title={row.title}
        folder={folder}
        agent={agent}
        file={row.sessionFile}
        className="mr-1"
      />
    </li>
  );
}

function Group({
  label,
  path,
  kind,
  branch,
  missing = false,
  nested = false,
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
  actions: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  const Heading = nested ? "h3" : "h2";
  return (
    // biome-ignore lint/a11y/useSemanticElements: a folder of links, not a form <fieldset>
    <div role="group" aria-labelledby={headingId} className="flex flex-col gap-0.5">
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 pr-1 pb-0.5 pl-2 text-xs text-muted-foreground",
          nested ? "pt-1.5" : "pt-3",
        )}
      >
        {/* The label keeps its width (truncating only past the whole line); the branch gets the rest. */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ListingGroupIcon kind={kind} />
          <Heading
            id={headingId}
            className={cn(
              "max-w-full shrink-0 truncate text-foreground/80",
              nested ? "font-normal" : "font-medium",
            )}
            title={path}
          >
            {label}
          </Heading>
          {branch !== undefined && (
            <span className="flex min-w-0 items-center gap-0.5 overflow-hidden" title="Branch">
              <GitBranchIcon aria-hidden className="size-3 shrink-0" />
              <span className="truncate font-mono">{branch}</span>
            </span>
          )}
          {missing && <MissingMark />}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

/**
 * Conversations grouped by folder or repo (`groupListing`), with New conversation, search,
 * per-folder `+`, New and Remove worktree on repo groups, Stop or Delete on every row (`×`) and
 * settings in the footer. `action` goes before New conversation (the shell's toggle, the sheet's
 * close); `onSelect` runs whenever a row, `+` or a new conversation is picked.
 */
export function Sidebar({ action, onSelect }: { action?: ReactNode; onSelect?: () => void }) {
  const { loaded, agents, sessions, branches } = useLive(
    useShallow((s) => ({
      loaded: s.loaded,
      agents: s.agents,
      sessions: s.sessions,
      branches: s.branches,
    })),
  );
  const currentId = useParams({ strict: false }).agentId;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const debounced = useDebouncedValue(trimmed, SEARCH_DEBOUNCE_MS);
  // Clearing the field shows the window at once; typing waits for the debounce.
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
  const select = () => onSelect?.();

  const groups = useMemo(() => {
    const allAgents = Object.values(agents);
    if (!searching) return buildSidebarGroups({ agents: allAgents, sessions });
    const results = search.data ?? [];
    return buildSidebarGroups({
      agents: allAgents,
      sessions: results,
      known: [...sessions, ...results],
      query,
    });
  }, [agents, sessions, searching, query, search.data]);

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

  /** Rows of one folder; in a `missing` one only live agents open, but every row deletes. */
  const rowList = (rows: SidebarRow[], folder: string, missing: boolean) => (
    <ul className="flex flex-col gap-0.5">
      {rows.map((row) => (
        <Row
          key={row.key}
          row={row}
          folder={folder}
          now={now}
          current={row.agent !== undefined && row.agent.id === currentId}
          pending={
            row.agent !== undefined
              ? restart.isPending && restart.variables === row.agent.id
              : pending !== undefined &&
                "sessionFile" in pending &&
                pending.sessionFile === row.sessionFile
          }
          disabled={busy || missing}
          onOpen={(sessionFile) => open.mutate({ sessionFile })}
          onRestart={(agent) => restart.mutate(agent.id)}
          onSelect={select}
        />
      ))}
    </ul>
  );

  return (
    <nav aria-label="Conversations" className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-3 border-b p-4">
        <div className="flex items-center gap-1">
          {action}
          <Button className="flex-1" onClick={() => setPickerOpen(true)}>
            <PlusIcon /> New conversation
          </Button>
        </div>
        <div className="relative">
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
      </div>
      <ProjectPicker open={pickerOpen} onOpenChange={setPickerOpen} onOpened={select} />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
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
        {groups.map((group) =>
          group.kind === "folder" ? (
            <Group
              key={`folder:${group.cwd}`}
              kind="folder"
              label={group.label}
              path={group.cwd}
              branch={liveBranch(branches, group.cwd, group.items)}
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
              actions={
                <>
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
                    const name = `${group.label}/${worktree.label}`;
                    return (
                      <Group
                        key={worktree.cwd}
                        kind="worktree"
                        nested
                        label={worktree.label}
                        path={worktree.cwd}
                        branch={liveBranch(branches, worktree.cwd, worktree.items)}
                        missing={worktree.missing}
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

      <div className="flex items-center border-t p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/settings" aria-label="Settings" onClick={select}>
            <SettingsIcon />
          </Link>
        </Button>
      </div>
    </nav>
  );
}
