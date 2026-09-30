/** Closes agents idle for a week (design/05-desktop.md, "Idle sweep"). */
import type { SessionCatalog } from "../catalog/sessions.ts";
import type { StreamHub } from "../live/stream-hub.ts";
import type { AgentManager } from "./agent-manager.ts";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Agents whose last activity is at least this old are closed. */
const IDLE_CLOSE_MS = 7 * 24 * 60 * 60 * 1000;

export interface IdleSweepDeps {
  manager: AgentManager;
  catalog: SessionCatalog;
  hub: Pick<StreamHub, "refreshCatalog">;
}

/**
 * One sweep: recomputes the catalog window (sessions past it drop out), then closes every agent
 * that isn't streaming and whose activity — the later of its `startedAt` and its session's
 * `updatedAt` — is at least `IDLE_CLOSE_MS` old, exited agents included. Close errors (e.g. a
 * concurrent `DELETE`) are ignored.
 */
export async function sweepIdle({ manager, catalog, hub }: IdleSweepDeps): Promise<void> {
  // The rescan also refreshes the summaries read below.
  await hub.refreshCatalog();
  const updatedAt = new Map((await catalog.sessions()).map((s) => [s.file, s.updatedAt]));
  const now = Date.now();
  const idle = manager.list().filter((agent) => {
    if (agent.isStreaming) return false;
    const file = agent.sessionFile;
    const session = file === undefined ? undefined : updatedAt.get(file);
    const activity = Math.max(
      Date.parse(agent.startedAt),
      session === undefined ? Number.NEGATIVE_INFINITY : Date.parse(session),
    );
    return now - activity >= IDLE_CLOSE_MS;
  });
  await Promise.all(idle.map((agent) => manager.close(agent.id).catch(() => {})));
}

/** Runs `sweepIdle` every hour until the returned function is called. */
export function startIdleSweep(deps: IdleSweepDeps): () => void {
  const timer = setInterval(() => {
    sweepIdle(deps).catch((e: unknown) => console.warn("[agents] idle sweep failed:", e));
  }, SWEEP_INTERVAL_MS);
  return () => clearInterval(timer);
}
