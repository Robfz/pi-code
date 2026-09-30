import type { AgentInfo } from "@pi-code/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { GitBranchIcon, LoaderIcon, PlusIcon, SearchIcon, SettingsIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { AttentionBadge } from "@/components/attention-badge";
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
import { closeAgent, errorMessage, searchSessions } from "@/lib/api";
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
  now,
  current,
  pending,
  disabled,
  closing,
  onOpen,
  onClose,
  onSelect,
}: {
  row: SidebarRow;
  now: number;
  current: boolean;
  pending: boolean;
  disabled: boolean;
  /** Its agent's DELETE is in flight. */
  closing: boolean;
  onOpen(sessionFile: string): void;
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
      {agent && <AttentionBadge attention={agent.attention} />}
      <time
        dateTime={new Date(row.activity).toISOString()}
        className="shrink-0 text-xs text-muted-foreground"
      >
        {formatRelative(new Date(row.activity).toISOString(), now)}
      </time>
    </>
  );
  // Live agents are navigated to; sessions and exited agents are resumed (restarting the agent).
  const navigates = agent !== undefined && (isLive(agent) || row.sessionFile === undefined);
  return (
    <li
      data-testid="sidebar-row"
      className={cn(
        "flex min-w-0 items-center rounded-md hover:bg-muted/60",
        current && "bg-muted font-medium",
      )}
    >
      {navigates ? (
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
            if (row.sessionFile !== undefined) onOpen(row.sessionFile);
            onSelect();
          }}
        >
          {content}
        </button>
      )}
      {agent && isLive(agent) && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="mr-1 text-muted-foreground"
          aria-label={`Close ${row.title}`}
          disabled={closing}
          onClick={() => onClose(agent)}
        >
          <XIcon />
        </Button>
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
        <h2 id={headingId} className="truncate font-medium text-foreground/80" title={group.cwd}>
          {group.label}
        </h2>
        {group.branch !== undefined && (
          <span className="flex min-w-0 items-center gap-0.5" title="Branch">
            <GitBranchIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate font-mono">{group.branch}</span>
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
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
  const [confirming, setConfirming] = useState<{ agentId: string; title: string } | null>(null);
  const open = useOpenAgent();
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
            type="search"
            aria-label="Search conversations"
            placeholder="Search…"
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="pl-8"
          />
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
            disabled={open.isPending}
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
                now={now}
                current={row.agent !== undefined && row.agent.id === currentId}
                pending={
                  pending !== undefined &&
                  "sessionFile" in pending &&
                  pending.sessionFile === row.sessionFile
                }
                disabled={open.isPending}
                closing={row.agent !== undefined && closing.has(row.agent.id)}
                onOpen={(sessionFile) => open.mutate({ sessionFile })}
                onClose={(agent) => {
                  if (closeNeedsConfirm(agent))
                    setConfirming({ agentId: agent.id, title: row.title });
                  else void close(agent.id);
                }}
                onSelect={select}
              />
            ))}
          </Group>
        ))}
      </div>

      <Dialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Close {confirming?.title}?</DialogTitle>
            <DialogDescription>
              pi is still working or waiting for your input; closing stops it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirming) void close(confirming.agentId);
                setConfirming(null);
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
