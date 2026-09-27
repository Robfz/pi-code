import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { getHealth } from "@/lib/api";
import { queryKeys } from "@/lib/query-client";

export type ServerStatus = "online" | "offline" | "unreachable";

/** Health polling cadence while reachable / while failing. */
export const HEALTH_INTERVAL_MS = 30_000;
export const HEALTH_RETRY_INTERVAL_MS = 5_000;

function subscribeOnline(callback: () => void): () => void {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine !== false,
    () => true,
  );
}

/**
 * `offline` when the device has no network, `unreachable` when `GET /api/health` fails (one
 * quick retry first, so a single blip doesn't flash the banner), else `online`.
 */
export function useServerStatus(): { status: ServerStatus; checking: boolean; retry(): void } {
  const online = useOnline();
  const health = useQuery({
    queryKey: queryKeys.health,
    queryFn: getHealth,
    // Also runs while the browser thinks it's offline, so recovery is noticed.
    networkMode: "always",
    retry: 1,
    retryDelay: 1_000,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: (query) =>
      query.state.status === "error" ? HEALTH_RETRY_INTERVAL_MS : HEALTH_INTERVAL_MS,
  });
  const status: ServerStatus = !online ? "offline" : health.isError ? "unreachable" : "online";
  return {
    status,
    checking: health.isFetching,
    retry: () => void health.refetch(),
  };
}
