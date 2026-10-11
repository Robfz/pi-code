import type { AgentId, AgentInfo } from "@pi-code/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { LoaderIcon, XIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isLive } from "@/lib/agents";
import { closeAgent, deleteSession, errorMessage } from "@/lib/api";
import { queryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { useLive, useLiveRegistry } from "@/store/context";

/** An agent's conversation (its current session file), or a session file no agent holds. */
export type SessionTarget = { agent: AgentInfo } | { file: string };

interface StopOrDelete {
  /** A row's `×`: a live agent asks Stop or Delete; an exited agent or a session is deleted. */
  dismiss(target: SessionTarget, title: string): void;
  /** Stops pi (`DELETE /api/agents/:id`); the conversation stays listed. */
  stop(agent: AgentInfo): void;
  /** Deletes the session file (the server stops its agents); an agent without one is stopped. */
  remove(target: SessionTarget): void;
  /** The target's request is in flight. */
  pending(target: SessionTarget): boolean;
}

const StopOrDeleteContext = createContext<StopOrDelete | null>(null);

const targetKey = (target: SessionTarget) => ("agent" in target ? target.agent.id : target.file);

/**
 * Owns the Stop-or-Delete dialog, mounted once at the app root so it outlives the row that opened
 * it. Stopping or deleting the conversation on screen goes back to Home; failures are toasts.
 */
export function StopOrDeleteProvider({ children }: { children: ReactNode }) {
  const registry = useLiveRegistry();
  const queryClient = useQueryClient();
  const router = useRouter();
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  // The agent outlives `open` so the title holds while the dialog fades out.
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState<{ agent: AgentInfo; title: string } | null>(null);

  const track = (key: string, running: boolean) => {
    if (running) inFlight.current.add(key);
    else inFlight.current.delete(key);
    setPending(new Set(inFlight.current));
  };

  const onScreen = (agentId: AgentId) =>
    router.state.matches.some(
      (match) => (match.params as { agentId?: string }).agentId === agentId,
    );

  async function run(target: SessionTarget, request: () => Promise<void>) {
    const key = targetKey(target);
    if (inFlight.current.has(key)) return;
    track(key, true);
    try {
      await request();
      if ("agent" in target) {
        const { id } = target.agent;
        if (onScreen(id)) await router.navigate({ to: "/" });
        registry.drop(id);
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      track(key, false);
      // The catalog frame only covers the 7-day window and leaves out `ownedBy`.
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    }
  }

  const stop = (agent: AgentInfo) => void run({ agent }, () => closeAgent(agent.id));
  const remove = (target: SessionTarget) => {
    const file = "agent" in target ? target.agent.sessionFile : target.file;
    if (file !== undefined) void run(target, () => deleteSession(file));
    // pi writes no session file before the first message: nothing to delete yet.
    else if ("agent" in target) stop(target.agent);
  };

  const actions: StopOrDelete = {
    dismiss: (target, title) => {
      if ("agent" in target && isLive(target.agent)) {
        setAsked({ agent: target.agent, title });
        setOpen(true);
      } else remove(target);
    },
    stop,
    remove,
    pending: (target) => pending.has(targetKey(target)),
  };

  const choose = (action: (agent: AgentInfo) => void) => {
    if (!open || !asked) return;
    setOpen(false);
    // Its session file may have changed while the dialog was open.
    action(registry.live.getState().agents[asked.agent.id] ?? asked.agent);
  };

  return (
    <StopOrDeleteContext.Provider value={actions}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="break-words">Stop or delete {asked?.title}?</DialogTitle>
            <DialogDescription>
              Stop ends pi and keeps the conversation. Delete also moves it to the Trash.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => choose(stop)}>
              Stop
            </Button>
            <Button variant="destructive" onClick={() => choose((agent) => remove({ agent }))}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </StopOrDeleteContext.Provider>
  );
}

export function useStopOrDelete(): StopOrDelete {
  const actions = useContext(StopOrDeleteContext);
  if (actions === null) throw new Error("useStopOrDelete outside StopOrDeleteProvider");
  return actions;
}

/**
 * A row's `×`: `agent`'s conversation, else that of the registry's agent holding `file`, else the
 * session `file`. Off while its own request is in flight.
 */
export function StopOrDeleteButton({
  title,
  folder,
  agent,
  file,
  className,
}: {
  title: string;
  /** The row's folder label, to tell apart same-titled rows. */
  folder: string;
  agent?: AgentInfo | undefined;
  file?: string | undefined;
  className?: string;
}) {
  const { dismiss, pending } = useStopOrDelete();
  const owner = useLive((s) =>
    agent !== undefined || file === undefined
      ? undefined
      : Object.values(s.agents).find((a) => a.sessionFile === file),
  );
  const holder = agent ?? owner;
  const target: SessionTarget | undefined = holder
    ? { agent: holder }
    : file !== undefined
      ? { file }
      : undefined;
  if (target === undefined) return null;
  const busy = pending(target);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={cn("shrink-0 text-muted-foreground", className)}
      aria-label={`${holder && isLive(holder) ? "Stop or delete" : "Delete"} ${title} (${folder})`}
      disabled={busy}
      onClick={() => dismiss(target, title)}
    >
      {busy ? <LoaderIcon className="animate-spin" /> : <XIcon />}
    </Button>
  );
}
