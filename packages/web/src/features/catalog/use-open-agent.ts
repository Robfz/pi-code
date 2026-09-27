import type { OpenAgentBody } from "@pi-code/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { errorMessage, openAgent } from "@/lib/api";
import { queryKeys } from "@/lib/query-client";

/**
 * `POST /api/agents` (new conversation in a folder, or resume a session — the server returns
 * the existing agent when the session is already open), then navigate to the conversation.
 */
export function useOpenAgent({ toastErrors = true }: { toastErrors?: boolean } = {}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: OpenAgentBody) => openAgent(body),
    onSuccess: (agent) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void navigate({ to: "/agents/$agentId", params: { agentId: agent.id } });
    },
    onError: (error) => {
      if (toastErrors) toast.error(errorMessage(error));
    },
  });
}
