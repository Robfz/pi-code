import type { AgentInfo, OpenAgentBody } from "@pi-code/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { errorMessage, openAgent } from "@/lib/api";

/**
 * What follows a request that returns a new or existing agent: `onOpened` (e.g. to hand the
 * composer a draft), refetch the session lists, then navigate to the conversation.
 */
export function useShowOpenedAgent(onOpened?: (agent: AgentInfo) => void) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return (agent: AgentInfo) => {
    onOpened?.(agent);
    void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    void navigate({ to: "/agents/$agentId", params: { agentId: agent.id } });
  };
}

/**
 * `POST /api/agents` (new conversation in a folder, or resume a session — the server returns
 * the existing agent when the session is already open), then `useShowOpenedAgent`.
 */
export function useOpenAgent({
  toastErrors = true,
  onOpened,
}: {
  toastErrors?: boolean;
  onOpened?: (agent: AgentInfo) => void;
} = {}) {
  const show = useShowOpenedAgent(onOpened);
  return useMutation({
    mutationFn: (body: OpenAgentBody) => openAgent(body),
    onSuccess: show,
    onError: (error) => {
      if (toastErrors) toast.error(errorMessage(error));
    },
  });
}
