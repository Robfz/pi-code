import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { toast } from "sonner";
import { useReviewStore } from "@/features/review/review-state";
import { rpc } from "@/lib/api";
import { queryKeys } from "@/lib/query-client";
import { useIsDesktop } from "@/lib/use-media-query";
import { useConversation } from "@/store/context";
import { useOpenSheet } from "./action-sheets";
import { useSessionActions } from "./session-actions";
import { findBuiltin, THINKING_LEVELS } from "./slash-commands";

export const TUI_ONLY_MESSAGE = "Use the TUI for this";

/**
 * Runs a client-side built-in slash command. Resolves to `false` when `name` isn't a built-in
 * (the text should then go to pi as a prompt).
 */
export function useBuiltinCommands(): (name: string, args: string) => Promise<boolean> {
  const agentId = useConversation((s) => s.agentId);
  const cwd = useConversation((s) => s.agent.cwd);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const actions = useSessionActions();
  const openSheet = useOpenSheet();
  const desktop = useIsDesktop();

  return useCallback(
    async (name: string, args: string) => {
      const command = findBuiltin(name);
      if (command === undefined) return false;
      if (command.tuiOnly) {
        toast.info(TUI_ONLY_MESSAGE, { description: `/${name} isn't available in pi-code.` });
        return true;
      }
      switch (name) {
        case "new":
          await actions.newSession();
          break;
        case "resume":
          void navigate({ to: "/sessions", search: cwd ? { cwd } : {} });
          break;
        case "name":
          if (args === "") openSheet("rename");
          else if (await actions.rename(args)) toast.success(`Renamed to “${args}”`);
          break;
        case "model": {
          if (args === "") {
            openSheet("model");
            break;
          }
          const slash = args.indexOf("/");
          if (slash > 0) {
            await actions.setModel(args.slice(0, slash), args.slice(slash + 1));
            break;
          }
          try {
            const { models } = await queryClient.fetchQuery({
              queryKey: queryKeys.models(agentId),
              queryFn: () => rpc(agentId, { type: "get_available_models" }),
              staleTime: 60_000,
            });
            const match = models.find((m) => m.id === args);
            if (match) await actions.setModel(match.provider, match.id);
            else toast.error(`Unknown model: ${args}`);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
          }
          break;
        }
        case "thinking": {
          if (args === "") {
            openSheet("thinking");
            break;
          }
          const level = THINKING_LEVELS.find((l) => l === args);
          if (level) await actions.setThinkingLevel(level);
          else toast.error(`Unknown thinking level: ${args}`);
          break;
        }
        case "compact":
          await actions.compact(args);
          break;
        case "tree":
          if (desktop) useReviewStore.getState().openPane(agentId, "tree");
          else void navigate({ to: "/agents/$agentId/tree", params: { agentId } });
          break;
        case "fork":
          openSheet("fork");
          break;
        case "clone":
          await actions.clone();
          break;
        case "session":
          openSheet("stats");
          break;
        case "copy":
          await actions.copyLastAssistantText();
          break;
        case "diff":
          if (desktop) useReviewStore.getState().toggleTab(agentId, "changes");
          else void navigate({ to: "/agents/$agentId/diff", params: { agentId } });
          break;
        default:
          return false;
      }
      return true;
    },
    [actions, agentId, cwd, desktop, navigate, openSheet, queryClient],
  );
}
