import type { AgentInfo, OpenAgentBody } from "@pi-code/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { errorMessage, openAgent } from "@/lib/api";

/**
 * `POST /api/agents` (new conversation in a folder, or resume a session — the server returns
 * the existing agent when the session is already open), then navigate to the conversation.
 * `onOpened` runs before the navigation (e.g. to hand the composer a draft).
 */
export function useOpenAgent({
  toastErrors = true,
  onOpened,
}: {
  toastErrors?: boolean;
  onOpened?: (agent: AgentInfo) => void;
} = {}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: OpenAgentBody) => openAgent(body),
    onSuccess: (agent) => {
      onOpened?.(agent);
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void navigate({ to: "/agents/$agentId", params: { agentId: agent.id } });
    },
    onError: (error) => {
      if (toastErrors) toast.error(errorMessage(error));
    },
  });
}
