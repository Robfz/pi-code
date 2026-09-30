import type { AgentInfo } from "@pi-code/protocol";
import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useLive } from "@/store/context";

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
 * Agents needing attention, minus the one on screen (its attention is being cleared by
 * `POST /ack`, which the agents may not reflect yet).
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
 * While the app is visible and the live stream is up, keep the icon badge equal to the agents
 * needing attention — in particular, clear it once nothing is left. Push messages set it while
 * the app is closed.
 */
export function useBadgeSync(): void {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const visibleAgentId = agentIdFromPath(pathname);
  // A primitive (`live` implies a baseline): agent frames that keep the count don't re-render.
  const count = useLive((s) =>
    s.connection === "live" ? attentionCount(Object.values(s.agents), visibleAgentId) : undefined,
  );
  useEffect(() => {
    if (count === undefined) return;
    if (document.visibilityState === "visible") void applyBadge(count);
  }, [count]);
}
