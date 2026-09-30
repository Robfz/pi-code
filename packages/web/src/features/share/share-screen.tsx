import type { AgentInfo } from "@pi-code/protocol";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowRightIcon, FolderIcon, LoaderIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AgentsLoading } from "@/features/catalog/agents-loading";
import { ProjectPicker } from "@/features/catalog/project-picker";
import { SessionList } from "@/features/catalog/session-list";
import { useConversationUi } from "@/features/conversation/conversation-ui";
import { errorMessage, listSessions } from "@/lib/api";
import { baseName } from "@/lib/content";
import { queryKeys } from "@/lib/query-client";
import { PlaceholderScreen } from "@/routes/placeholder";
import { useLiveAgents } from "@/store/context";
import { composeShareText, parseShareParams } from "./share-text";

const RECENT_SESSIONS = 8;

function Loading() {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderIcon className="size-4 animate-spin" /> Loading…
    </p>
  );
}

/**
 * Share-target landing (`/share?title&text&url`): the composed text (editable), then a
 * destination — an open agent, a recent session or a new conversation. The text becomes the
 * conversation's composer draft.
 */
export function ShareScreen() {
  const router = useRouter();
  const navigate = useNavigate();
  // The raw query string: the router's parsed search turns "123" or "{…}" into JSON values.
  const [text, setText] = useState(() =>
    composeShareText(parseShareParams(router.history.location.search)),
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const openAgents = useLiveAgents();
  const sessions = useQuery({ queryKey: queryKeys.sessions(), queryFn: () => listSessions() });

  const handOff = (agent: Pick<AgentInfo, "id">) => {
    if (text.trim() !== "") useConversationUi.getState().setDraft(agent.id, text);
  };
  const sendToAgent = (agent: AgentInfo) => {
    handOff(agent);
    void navigate({ to: "/agents/$agentId", params: { agentId: agent.id } });
  };

  const recent = (sessions.data ?? []).filter((s) => s.ownedBy === undefined);

  return (
    <PlaceholderScreen title="Send to…">
      <div className="flex flex-col gap-6 pb-8">
        <Textarea
          aria-label="Shared text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Nothing was shared — type a message"
          className="max-h-48 min-h-20 text-base text-foreground md:text-sm"
        />

        <Button className="h-11" onClick={() => setPickerOpen(true)}>
          <PlusIcon /> New conversation in…
        </Button>
        <ProjectPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          title="New conversation in…"
          onOpened={handOff}
        />

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Open conversations</h2>
          {openAgents === undefined && <AgentsLoading />}
          {openAgents?.length === 0 && (
            <p className="text-sm text-muted-foreground">No open conversations.</p>
          )}
          {openAgents !== undefined && openAgents.length > 0 && (
            <ul className="flex flex-col gap-2" aria-label="Open conversations">
              {openAgents.map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    onClick={() => sendToAgent(agent)}
                    className="flex w-full min-w-0 items-center gap-3 rounded-xl border bg-card/40 px-3 py-2.5 text-left hover:bg-muted/50"
                  >
                    <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium text-foreground">
                        {agent.sessionName ?? baseName(agent.cwd)}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">{agent.cwd}</span>
                    </span>
                    <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Recent sessions</h2>
          {sessions.isPending && <Loading />}
          {sessions.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(sessions.error)}
            </p>
          )}
          {sessions.data && recent.length === 0 && (
            <p className="text-sm text-muted-foreground">No other sessions.</p>
          )}
          {recent.length > 0 && (
            <SessionList
              sessions={recent.slice(0, RECENT_SESSIONS)}
              label="Recent sessions"
              onOpened={handOff}
            />
          )}
        </section>
      </div>
    </PlaceholderScreen>
  );
}
