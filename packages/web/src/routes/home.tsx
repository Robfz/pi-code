import type { AgentInfo } from "@pi-code/protocol";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FolderIcon, HistoryIcon, LoaderIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";
import { AttentionBadge } from "@/components/attention-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentsLoading } from "@/features/catalog/agents-loading";
import { ProjectPicker } from "@/features/catalog/project-picker";
import { SessionList } from "@/features/catalog/session-list";
import { errorMessage, listSessions } from "@/lib/api";
import { baseName } from "@/lib/content";
import { queryKeys } from "@/lib/query-client";
import { useLiveAgents } from "@/store/context";

function statusLabel(agent: AgentInfo): string | null {
  switch (agent.status) {
    case "awaiting_trust":
      return "Trust?";
    case "starting":
      return "Starting";
    case "exited":
      return "Exited";
    default:
      return agent.isStreaming ? "Running" : null;
  }
}

function AgentRow({ agent }: { agent: AgentInfo }) {
  const status = statusLabel(agent);
  return (
    <li>
      <Link
        to="/agents/$agentId"
        params={{ agentId: agent.id }}
        className="flex min-w-0 items-center gap-3 rounded-xl border bg-card/40 px-3 py-2.5 hover:bg-muted/50"
      >
        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">
            {agent.sessionName ?? baseName(agent.cwd)}
          </span>
          <span className="truncate text-xs text-muted-foreground">{agent.cwd}</span>
        </div>
        <AttentionBadge attention={agent.attention} />
        {status && (
          <Badge variant="outline" className="gap-1">
            {agent.isStreaming && <LoaderIcon className="animate-spin" />}
            {status}
          </Badge>
        )}
      </Link>
    </li>
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
        <SessionList sessions={sessions.data.slice(0, RECENT_SESSIONS)} label="Recent sessions" />
      )}
    </section>
  );
}

export function HomeScreen() {
  const [pickerOpen, setPickerOpen] = useState(false);
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
        {agents !== undefined && agents.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label="Open conversations">
            {agents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} />
            ))}
          </ul>
        )}
      </section>

      <RecentSessions />
    </div>
  );
}
