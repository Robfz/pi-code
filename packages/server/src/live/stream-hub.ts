import type { SessionSummary, StreamFrame } from "@pi-code/protocol";
import type { AgentManager } from "../agents/agent-manager.ts";
import type { SessionCatalog } from "../catalog/sessions.ts";

/** Sessions updated within this long are in the catalog window. */
const CATALOG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type BaselineFrame = Extract<StreamFrame, { type: "baseline" }>;

/** Frames every connection receives, whatever it opened. */
export type HubFrame = Extract<StreamFrame, { type: "agent" | "agent_closed" }>;

export interface StreamHubDeps {
  manager: AgentManager;
  catalog: SessionCatalog;
}

/**
 * Sessions updated within the last `CATALOG_WINDOW_MS`, most recent first, without `ownedBy`
 * (it would go stale; clients match agents by `sessionFile`).
 */
async function catalogWindow(catalog: SessionCatalog): Promise<SessionSummary[]> {
  const sessions = await catalog.sessions();
  const now = Date.now();
  return sessions
    .filter((s) => now - Date.parse(s.updatedAt) <= CATALOG_WINDOW_MS)
    .map(({ ownedBy: _, ...session }) => session);
}

/**
 * The live stream's shared inputs: turns manager events into frames for every connection and
 * keeps the catalog window and the branch map in memory, so baselines are built without I/O.
 */
export class StreamHub {
  /** Resolves once the first catalog window is computed. */
  readonly ready: Promise<void>;
  private readonly manager: AgentManager;
  private sessions: SessionSummary[] = [];
  private readonly branches: Record<string, string> = {};
  private readonly listeners = new Set<(frame: HubFrame) => void>();

  constructor(deps: StreamHubDeps) {
    this.manager = deps.manager;
    this.ready = catalogWindow(deps.catalog).then(
      (sessions) => {
        this.sessions = sessions;
      },
      (e: unknown) => console.warn(`[stream] catalog scan failed: ${(e as Error).message}`),
    );
    deps.manager.on("agent", (agent) => this.broadcast({ type: "agent", agent }));
    deps.manager.on("closed", (agentId) => this.broadcast({ type: "agent_closed", agentId }));
  }

  baseline(): BaselineFrame {
    return {
      type: "baseline",
      agents: this.manager.list(),
      sessions: this.sessions,
      branches: this.branches,
    };
  }

  /** Listens to every hub frame; returns the unsubscribe function. */
  subscribe(listener: (frame: HubFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private broadcast(frame: HubFrame): void {
    for (const listener of this.listeners) listener(frame);
  }
}
