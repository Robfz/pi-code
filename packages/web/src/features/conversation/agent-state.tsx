import { useNavigate } from "@tanstack/react-router";
import { LoaderIcon, PowerIcon, RotateCcwIcon, ShieldQuestionIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { closeAgent, errorMessage, restartAgent, trustAgent } from "@/lib/api";
import { useConversation } from "@/store/context";
import { selectAgent } from "@/store/selectors";

/** Project-trust prompt for an `awaiting_trust` agent → `POST /trust`. */
export function TrustSheet() {
  const agent = useConversation(selectAgent);
  const hydrated = useConversation((s) => s.hydrated);
  const [busy, setBusy] = useState(false);
  if (!hydrated || agent.status !== "awaiting_trust") return null;
  const cwd = agent.trustPrompt?.cwd ?? agent.cwd;

  async function answer(trusted: boolean) {
    setBusy(true);
    try {
      // The `agent_status` event that follows carries the new status.
      await trustAgent(agent.id, trusted);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        data-testid="trust-sheet"
        className="rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ShieldQuestionIcon className="size-4" /> Trust this project?
          </SheetTitle>
          <SheetDescription asChild>
            <div className="flex flex-col gap-2">
              <code className="rounded bg-muted px-2 py-1 font-mono text-xs break-all text-foreground">
                {cwd}
              </code>
              <span>
                Trusting loads the project's own pi resources — extensions, skills, prompt templates
                and settings from its <code>.pi</code> folder. Extensions run code on this machine.
                pi remembers the answer.
              </span>
            </div>
          </SheetDescription>
        </SheetHeader>
        <SheetFooter className="flex-row justify-end">
          <Button variant="outline" disabled={busy} onClick={() => void answer(false)}>
            Don't trust
          </Button>
          <Button disabled={busy} onClick={() => void answer(true)}>
            Trust
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Loading, starting and exited states shown in place of (or before) the transcript. */
export function AgentStatePanel() {
  const navigate = useNavigate();
  const agent = useConversation(selectAgent);
  const hydrated = useConversation((s) => s.hydrated);
  const loadError = useConversation((s) => s.loadError);
  const [busy, setBusy] = useState(false);

  if (loadError) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-12 text-center text-sm">
        <p className="text-muted-foreground">
          {loadError.code === "agent_not_found"
            ? "This conversation is closed."
            : loadError.message}
        </p>
        <Button variant="outline" onClick={() => void navigate({ to: "/" })}>
          Back to home
        </Button>
      </div>
    );
  }

  if (!hydrated || agent.status === "starting") {
    return (
      <div
        data-testid="agent-starting"
        className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"
      >
        <LoaderIcon className="size-4 animate-spin" />
        {hydrated ? "Starting pi…" : "Loading…"}
      </div>
    );
  }

  if (agent.status !== "exited") return null;

  async function restart() {
    setBusy(true);
    try {
      await restartAgent(agent.id);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    setBusy(true);
    try {
      await closeAgent(agent.id);
      void navigate({ to: "/" });
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="agent-exited"
      className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3"
    >
      <p className="text-sm font-medium">
        pi exited{agent.exitCode !== undefined ? ` with code ${agent.exitCode}` : ""}
      </p>
      {agent.stderrTail && agent.stderrTail.length > 0 && (
        <pre className="max-h-60 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs whitespace-pre-wrap break-words">
          {agent.stderrTail.join("\n")}
        </pre>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void close()}>
          <PowerIcon /> Close
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void restart()}>
          <RotateCcwIcon /> Restart
        </Button>
      </div>
    </div>
  );
}
