import type { AgentInfo } from "@pi-code/protocol";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { GitBranchIcon, LoaderIcon, PlusIcon, SearchIcon, SettingsIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { AttentionIcon } from "@/components/attention-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ProjectPicker } from "@/features/catalog/project-picker";
import { useOpenAgent } from "@/features/catalog/use-open-agent";
import { closeAgent, errorMessage, restartAgent, searchSessions } from "@/lib/api";
import { queryKeys } from "@/lib/query-client";
import { formatRelative } from "@/lib/time";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { cn } from "@/lib/utils";
import { useLive, useLiveRegistry } from "@/store/context";
import { buildSidebarGroups, isLive, type SidebarGroup, type SidebarRow } from "./sidebar-model";

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

/** Closing loses work in progress, so the sidebar asks first. */
const closeNeedsConfirm = (agent: AgentInfo) => agent.isStreaming || agent.attention === "input";

function RowMark({ row, pending }: { row: SidebarRow; pending: boolean }) {
  const agent = row.agent;
  let mark: ReactNode = null;
  if (pending || (agent && (agent.isStreaming || agent.status === "starting"))) {
    mark = (
      <span role="img" aria-label="Working">
        <LoaderIcon aria-hidden className="size-3.5 animate-spin text-muted-foreground" />
      </span>
    );
  } else if (agent && isLive(agent)) {
    mark = <span role="img" aria-label="Live" className="size-2 rounded-full bg-emerald-500" />;
  }
  return <span className="flex size-4 shrink-0 items-center justify-center">{mark}</span>;
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
  closing,
  onOpen,
  onRestart,
  onClose,
  onSelect,
}: {
  row: SidebarRow;
  /** The group's label, to tell apart same-titled rows in the close button's label. */
  folder: string;
  now: number;
  current: boolean;
  pending: boolean;
  disabled: boolean;
  /** Its agent's DELETE is in flight. */
  closing: boolean;
  onOpen(sessionFile: string): void;
  onRestart(agent: AgentInfo): void;
  onClose(agent: AgentInfo): void;
  onSelect(): void;
}) {
  const agent = row.agent;
  const content = (
    <>
      <RowMark row={row} pending={pending} />
      <span data-testid="sidebar-row-title" className="min-w-0 flex-1 truncate">
        {row.title}
      </span>
      {agent && <AttentionIcon attention={agent.attention} />}
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
      {live ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className="mr-1 text-muted-foreground"
          aria-label={`Close ${row.title} (${folder})`}
          disabled={closing}
          onClick={() => onClose(agent)}
        >
          <XIcon />
        </Button>
      ) : (
        // Keeps the times aligned with the rows that have ×.
        <span aria-hidden className="mr-1 size-6 shrink-0" />
      )}
    </li>
  );
}

function Group({
  group,
  children,
  pending,
  disabled,
  onNew,
}: {
  group: SidebarGroup;
  children: ReactNode;
  pending: boolean;
  disabled: boolean;
  onNew(): void;
}) {
  const headingId = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a folder of links, not a form <fieldset>
    <div role="group" aria-labelledby={headingId} className="flex flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-2 pt-3 pr-1 pb-0.5 pl-2 text-xs text-muted-foreground">
        {/* The label keeps its width (truncating only past the whole line); the branch gets the rest. */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h2
            id={headingId}
            className="max-w-full shrink-0 truncate font-medium text-foreground/80"
            title={group.cwd}
          >
            {group.label}
          </h2>
          {group.branch !== undefined && (
            <span className="flex min-w-0 items-center gap-0.5 overflow-hidden" title="Branch">
              <GitBranchIcon aria-hidden className="size-3 shrink-0" />
              <span className="truncate font-mono">{group.branch}</span>
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          aria-label={`New conversation in ${group.label}`}
          onClick={onNew}
        >
          {pending ? <LoaderIcon className="animate-spin" /> : <PlusIcon />}
        </Button>
      </div>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}

/**
 * Conversations grouped by folder, with New conversation, search, per-folder `+`, close on live
 * rows and settings in the footer. `action` goes before New conversation (the shell's toggle,
 * the sheet's close); `onSelect` runs whenever a row, `+` or a new conversation is picked.
 */
export function Sidebar({ action, onSelect }: { action?: ReactNode; onSelect?: () => void }) {
  const registry = useLiveRegistry();
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
  const [closing, setClosing] = useState<ReadonlySet<string>>(new Set());
  // The target outlives `confirmOpen` so the title holds while the dialog fades out.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<{ agentId: string; title: string } | null>(
    null,
  );
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
    if (!searching) return buildSidebarGroups({ agents: allAgents, sessions, branches });
    const results = search.data ?? [];
    return buildSidebarGroups({
      agents: allAgents,
      sessions: results,
      branches,
      known: [...sessions, ...results],
      query,
    });
  }, [agents, sessions, branches, searching, query, search.data]);

  async function close(agentId: string) {
    setClosing((ids) => new Set(ids).add(agentId));
    try {
      await closeAgent(agentId);
      registry.drop(agentId);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setClosing((ids) => {
        const next = new Set(ids);
        next.delete(agentId);
        return next;
      });
    }
  }

  return (
    <nav aria-label="Conversations" className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b p-2">
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

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
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
        {groups.map((group) => (
          <Group
            key={group.cwd}
            group={group}
            disabled={busy}
            pending={pending !== undefined && "cwd" in pending && pending.cwd === group.cwd}
            onNew={() => {
              open.mutate({ cwd: group.cwd });
              select();
            }}
          >
            {group.rows.map((row) => (
              <Row
                key={row.key}
                row={row}
                folder={group.label}
                now={now}
                current={row.agent !== undefined && row.agent.id === currentId}
                pending={
                  row.agent !== undefined
                    ? restart.isPending && restart.variables === row.agent.id
                    : pending !== undefined &&
                      "sessionFile" in pending &&
                      pending.sessionFile === row.sessionFile
                }
                disabled={busy}
                closing={row.agent !== undefined && closing.has(row.agent.id)}
                onOpen={(sessionFile) => open.mutate({ sessionFile })}
                onRestart={(agent) => restart.mutate(agent.id)}
                onClose={(agent) => {
                  if (closeNeedsConfirm(agent)) {
                    setConfirmTarget({ agentId: agent.id, title: row.title });
                    setConfirmOpen(true);
                  } else void close(agent.id);
                }}
                onSelect={select}
              />
            ))}
          </Group>
        ))}
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Close {confirmTarget?.title}?</DialogTitle>
            <DialogDescription>
              pi is still working or waiting for your input; closing stops it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmTarget) void close(confirmTarget.agentId);
                setConfirmOpen(false);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex items-center border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/settings" aria-label="Settings" onClick={select}>
            <SettingsIcon />
          </Link>
        </Button>
      </div>
    </nav>
  );
}
