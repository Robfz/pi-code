import type { AgentInfo, Attention } from "@pi-code/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { FolderIcon, HistoryIcon, LoaderIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, listAgents, openAgent } from "@/lib/api";
import { baseName } from "@/lib/content";
import { queryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";

const ATTENTION: Record<Exclude<Attention, "none">, { label: string; className: string }> = {
  finished: {
    label: "Finished",
    className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  failed: { label: "Failed", className: "bg-destructive/15 text-destructive" },
  input: { label: "Needs input", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
};

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
  const attention = agent.attention !== "none" ? ATTENTION[agent.attention] : undefined;
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
        {attention && <Badge className={attention.className}>{attention.label}</Badge>}
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

/** Minimal "New conversation": a folder path → `POST /api/agents { cwd }` (picker in W7). */
function NewConversation() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [cwd, setCwd] = useState("");
  const open = useMutation({
    mutationFn: (path: string) => openAgent({ cwd: path }),
    onSuccess: (agent) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
      void navigate({ to: "/agents/$agentId", params: { agentId: agent.id } });
    },
  });
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const path = cwd.trim();
        if (path !== "") open.mutate(path);
      }}
    >
      <label htmlFor="new-cwd" className="text-sm font-medium">
        New conversation
      </label>
      <div className="flex gap-2">
        <Input
          id="new-cwd"
          value={cwd}
          onChange={(event) => setCwd(event.target.value)}
          placeholder="/home/you/project"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-10 font-mono text-base md:text-sm"
        />
        <Button type="submit" className="h-10" disabled={open.isPending || cwd.trim() === ""}>
          {open.isPending ? <LoaderIcon className="animate-spin" /> : <PlusIcon />}
          Start
        </Button>
      </div>
      {open.error && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(open.error)}
        </p>
      )}
    </form>
  );
}

export function HomeScreen() {
  const agents = useQuery({
    queryKey: queryKeys.agents,
    queryFn: listAgents,
    refetchInterval: 10_000,
  });
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

      <NewConversation />

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">Open conversations</h2>
        {agents.isPending && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin" /> Loading…
          </p>
        )}
        {agents.isError && (
          <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
            {errorMessage(agents.error)}
            <Button variant="outline" size="sm" onClick={() => void agents.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {agents.data && agents.data.length === 0 && (
          <p className="text-sm text-muted-foreground">No open conversations.</p>
        )}
        {agents.data && agents.data.length > 0 && (
          <ul className={cn("flex flex-col gap-2")} aria-label="Open conversations">
            {agents.data.map((agent) => (
              <AgentRow key={agent.id} agent={agent} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
