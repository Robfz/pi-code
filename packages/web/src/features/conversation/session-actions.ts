import type { ThinkingLevel } from "@pi-code/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { toast } from "sonner";
import { errorMessage, isApiRequestError, rpc } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useConversation } from "@/store/context";
import { useDrafts } from "@/store/drafts";

async function attempt<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    toast.error(errorMessage(error));
    return undefined;
  }
}

/**
 * Session-level commands shared by the header menu, slash commands, status bar and tree
 * screen. Each resolves to `true` when it took effect; failures surface as toasts. New
 * transcripts / state arrive over SSE (`transcript_reset`, `state`).
 */
export function useSessionActions() {
  const agentId = useConversation((s) => s.agentId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return useMemo(() => {
    const invalidateCatalog = () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    };
    return {
      async newSession(): Promise<boolean> {
        const data = await attempt(() => rpc(agentId, { type: "new_session" }));
        if (data === undefined) return false;
        if (data.cancelled) {
          toast.info("New session cancelled");
          return false;
        }
        invalidateCatalog();
        toast.success("Started a new session");
        return true;
      },

      async clone(): Promise<boolean> {
        const data = await attempt(() => rpc(agentId, { type: "clone" }));
        if (data === undefined) return false;
        if (data.cancelled) {
          toast.info("Clone cancelled");
          return false;
        }
        invalidateCatalog();
        toast.success("Cloned the session");
        return true;
      },

      /** Fork from a user message; its text goes back into the composer. */
      async fork(entryId: string): Promise<boolean> {
        const data = await attempt(() => rpc(agentId, { type: "fork", entryId }));
        if (data === undefined) return false;
        if (data.cancelled) {
          toast.info("Fork cancelled");
          return false;
        }
        invalidateCatalog();
        useDrafts.getState().replace(agentId, data.text);
        toast.success("Forked into a new session");
        void navigate({ to: "/agents/$agentId", params: { agentId } });
        return true;
      },

      async rename(name: string): Promise<boolean> {
        const trimmed = name.trim();
        if (trimmed === "") return false;
        const ok = await attempt(async () => {
          await rpc(agentId, { type: "set_session_name", name: trimmed });
          return true;
        });
        if (ok) invalidateCatalog();
        return ok === true;
      },

      async compact(customInstructions?: string): Promise<boolean> {
        const instructions = customInstructions?.trim();
        try {
          await rpc(
            agentId,
            instructions
              ? { type: "compact", customInstructions: instructions }
              : { type: "compact" },
          );
        } catch (error) {
          // pi reports its own compaction failures with `compaction_end`, shown inline in the
          // transcript; only failures that never reached pi get a toast.
          if (!isApiRequestError(error, "pi_error")) toast.error(errorMessage(error));
          return false;
        }
        toast.success("Context compacted");
        return true;
      },

      async copyLastAssistantText(): Promise<boolean> {
        const data = await attempt(() => rpc(agentId, { type: "get_last_assistant_text" }));
        if (data === undefined) return false;
        if (data.text === null || data.text === "") {
          toast.info("No assistant message to copy");
          return false;
        }
        const ok = await copyText(data.text);
        if (ok) toast.success("Copied the last assistant message");
        else toast.error("Couldn't copy to the clipboard");
        return ok;
      },

      async setModel(provider: string, modelId: string): Promise<boolean> {
        const data = await attempt(() => rpc(agentId, { type: "set_model", provider, modelId }));
        return data !== undefined;
      },

      async setThinkingLevel(level: ThinkingLevel): Promise<boolean> {
        const ok = await attempt(async () => {
          await rpc(agentId, { type: "set_thinking_level", level });
          return true;
        });
        return ok === true;
      },
    };
  }, [agentId, navigate, queryClient]);
}

export type SessionActions = ReturnType<typeof useSessionActions>;
