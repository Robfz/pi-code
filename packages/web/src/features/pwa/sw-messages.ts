import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import { queryKeys } from "@/lib/query-client";
import { isSwMessage, SW_MESSAGE, safeAppPath } from "@/sw/push-logic";

/**
 * Messages from the service worker:
 * - `navigate` (notification click on this window) → route there without reloading.
 * - `push` → refresh the agents list; while visible (no system notification was shown), also
 *   toast unless the conversation is already on screen.
 */
export function useServiceWorkerMessages(): void {
  const router = useRouter();
  const queryClient = useQueryClient();
  useEffect(() => {
    const container = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!container) return;
    const onMessage = (event: MessageEvent) => {
      const message: unknown = event.data;
      if (!isSwMessage(message)) return;
      if (message.type === SW_MESSAGE.navigate) {
        router.history.push(safeAppPath(message.url));
        return;
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
      const { payload } = message;
      const path = safeAppPath(payload.url, payload.agentId);
      // Hidden windows got a system notification instead.
      if (document.visibilityState !== "visible") return;
      if (router.state.location.pathname === path) return;
      const show = payload.kind === "failed" ? toast.error : toast;
      show(payload.title, {
        id: `push:${payload.agentId}`,
        ...(payload.body ? { description: payload.body } : {}),
        action: { label: "Open", onClick: () => router.history.push(path) },
      });
    };
    container.addEventListener("message", onMessage);
    return () => container.removeEventListener("message", onMessage);
  }, [router, queryClient]);
}
