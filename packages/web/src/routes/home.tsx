import type { AgentInfo } from "@pi-code/protocol";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FolderIcon, HistoryIcon, LoaderIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useMemo } from "react";
import { StatusBadge } from "@/components/agent-status";
import { Button } from "@/components/ui/button";
import { AgentsLoading } from "@/features/catalog/agents-loading";
import { GroupedListing } from "@/features/catalog/grouped-listing";
import { agentLayout, agentRecency, groupListing } from "@/features/catalog/listing-groups";
import { ProjectPicker } from "@/features/catalog/project-picker";
import { GroupedSessionList } from "@/features/catalog/session-list";
import { useNewConversationPicker } from "@/features/catalog/use-new-conversation-picker";
import { StopOrDeleteButton } from "@/features/sessions/stop-or-delete";
import { agentStatus } from "@/lib/agent-status";
import { errorMessage, listSessions } from "@/lib/api";
import { baseName } from "@/lib/content";
import { queryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { useLive, useLiveAgents } from "@/store/context";

const agentRowClass = "flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5";

/**
 * `disabled`: an exited agent in a missing worktree, which can't be restarted (its `×` works);
 * `folder` names the row's folder in the `×`'s label.
 */
function AgentRow({
  agent,
  disabled,
  folder,
}: {
  agent: AgentInfo;
  disabled: boolean;
  folder: string;
}) {
  const title = agent.sessionName ?? baseName(agent.cwd);
  const content = (
    <>
      <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{title}</span>
        <span className="truncate text-xs text-muted-foreground">{agent.cwd}</span>
      </div>
      <StatusBadge status={agentStatus(agent)} />
    </>
  );
  return (
    <li
      className={cn(
        "flex min-w-0 items-center rounded-xl border bg-card/40",
        !disabled && "hover:bg-muted/50",
      )}
    >
      {disabled ? (
        <div className={cn(agentRowClass, "opacity-70")}>{content}</div>
      ) : (
        <Link to="/agents/$agentId" params={{ agentId: agent.id }} className={agentRowClass}>
          {content}
        </Link>
      )}
      <StopOrDeleteButton title={title} folder={folder} agent={agent} className="mr-2" />
    </li>
  );
}

function OpenConversations({ agents }: { agents: AgentInfo[] }) {
  const sessions = useLive((s) => s.sessions);
  const groups = useMemo(() => {
    const byFile = new Map(sessions.map((session) => [session.file, session]));
    return groupListing(agents, {
      cwd: (agent) => agent.cwd,
      layout: (agent) => agentLayout(agent, byFile),
      recency: (agent) =>
        agentRecency(agent, agent.sessionFile ? byFile.get(agent.sessionFile) : undefined),
    });
  }, [agents, sessions]);
  return (
    <GroupedListing
      label="Open conversations"
      groups={groups}
      renderItems={(items, missing, folder) => (
        <ul className="flex flex-col gap-2">
          {items.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              disabled={missing && agent.status === "exited"}
              folder={folder}
            />
          ))}
        </ul>
      )}
    />
  );
}

const RECENT_SESSIONS = 10;

function RecentSessions() {
  const sessions = useQuery({ queryKey: queryKeys.sessions(), queryFn: () => listSessions() });
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Recent sessions</h2>
        <Button variant="link" size="sm" className="h-auto px-0" asChild>
          <Link to="/sessions">All sessions</Link>
        </Button>
      </div>
      {sessions.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderIcon className="size-4 animate-spin" /> Loading…
        </p>
      )}
      {sessions.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(sessions.error)}
        </p>
      )}
      {sessions.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No sessions yet — they appear here once you've talked to pi.
        </p>
      )}
      {sessions.data && sessions.data.length > 0 && (
        <GroupedSessionList
          sessions={sessions.data.slice(0, RECENT_SESSIONS)}
          label="Recent sessions"
        />
      )}
    </section>
  );
}

export function HomeScreen() {
  const [pickerOpen, setPickerOpen] = useNewConversationPicker();
  const agents = useLiveAgents();
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">pi-code</h1>
        <nav className="flex gap-1">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/sessions" aria-label="Sessions">
              <HistoryIcon />
            </Link>
          </Button>
          <Button variant="ghost" size="icon" asChild>
            <Link to="/settings" aria-label="Settings">
              <SettingsIcon />
            </Link>
          </Button>
        </nav>
      </header>

      <Button className="h-11" onClick={() => setPickerOpen(true)}>
        <PlusIcon /> New conversation
      </Button>
      <ProjectPicker open={pickerOpen} onOpenChange={setPickerOpen} />

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">Open conversations</h2>
        {agents === undefined && <AgentsLoading />}
        {agents?.length === 0 && (
          <div className="flex flex-col gap-0.5 rounded-xl border border-dashed px-3 py-4 text-sm text-muted-foreground">
            <p>No open conversations.</p>
            <p className="text-xs">Start a new one, or tap a session below to resume it.</p>
          </div>
        )}
        {agents !== undefined && agents.length > 0 && <OpenConversations agents={agents} />}
      </section>

      <RecentSessions />
    </div>
  );
}
