import type { AgentInfo } from "@pi-code/protocol";
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { listAgents } from "@/lib/api";
import { queryKeys } from "@/lib/query-client";

interface BadgeNavigator {
  setAppBadge?(count?: number): Promise<void>;
  clearAppBadge?(): Promise<void>;
}

function badgeNavigator(): BadgeNavigator | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & BadgeNavigator;
  return typeof nav.setAppBadge === "function" ? nav : null;
}

/** `/agents/<id>` (or a child screen) → `<id>`. */
export function agentIdFromPath(pathname: string): string | undefined {
  const match = /^\/agents\/([^/]+)/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Agents needing attention, minus the one on screen (its attention is being cleared by the
 * snapshot / `POST /ack`, which the agents list may not reflect yet).
 */
export function attentionCount(agents: readonly AgentInfo[], visibleAgentId?: string): number {
  return agents.filter((a) => a.attention !== "none" && a.id !== visibleAgentId).length;
}

/** Apply the count to the app icon badge (no-op where Badging isn't supported). */
export async function applyBadge(count: number): Promise<void> {
  const nav = badgeNavigator();
  if (!nav) return;
  try {
    if (count > 0) await nav.setAppBadge?.(count);
    else await nav.clearAppBadge?.();
  } catch {
    // Best effort (e.g. not installed).
  }
}

/**
 * While the app is visible, keep the icon badge equal to the agents needing attention — in
 * particular, clear it once nothing is left. Push messages set it while the app is closed.
 */
export function useBadgeSync(): void {
  const supported = badgeNavigator() !== null;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const agents = useQuery({
    queryKey: queryKeys.agents,
    queryFn: listAgents,
    enabled: supported,
    refetchInterval: 30_000,
  });
  const visibleAgentId = agentIdFromPath(pathname);
  const count = agents.data ? attentionCount(agents.data, visibleAgentId) : undefined;
  useEffect(() => {
    if (count === undefined) return;
    if (document.visibilityState === "visible") void applyBadge(count);
  }, [count]);
}
