import type {
  AgentId,
  AgentInfo,
  AgentStatus,
  SessionSummary,
  StreamFrame,
} from "@pi-code/protocol";
import type { AgentManager } from "../agents/agent-manager.ts";
import type { SessionCatalog } from "../catalog/sessions.ts";
import { FolderBranches } from "../git/branches.ts";

/** Sessions updated within this long are in the catalog window. */
const CATALOG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Statuses of an agent whose pi process is running. */
const LIVE: ReadonlySet<AgentStatus> = new Set(["starting", "awaiting_trust", "ready"]);

type BaselineFrame = Extract<StreamFrame, { type: "baseline" }>;

/** Frames every connection receives, whatever it opened. */
export type HubFrame = Extract<
  StreamFrame,
  { type: "agent" | "agent_closed" | "catalog" | "branch" }
>;

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
 * The live stream's shared inputs: turns manager events, catalog rescans and folder branches
 * into frames for every connection, and keeps the catalog window and the branch map in memory,
 * so baselines are built without I/O.
 */
export class StreamHub {
  /** Resolves once the first catalog window is computed. */
  readonly ready: Promise<void>;
  private readonly manager: AgentManager;
  private readonly catalog: SessionCatalog;
  private sessions: SessionSummary[] = [];
  private readonly branches: FolderBranches;
  private readonly listeners = new Set<(frame: HubFrame) => void>();
  /** Rescans started, and the latest one whose window was applied. */
  private scansStarted = 0;
  private scanApplied = 0;
  private readonly onAgent = (agent: AgentInfo) => {
    this.broadcast({ type: "agent", agent });
    this.syncBranches();
  };
  private readonly onClosed = (agentId: AgentId) => {
    this.broadcast({ type: "agent_closed", agentId });
    this.syncBranches();
  };

  constructor(deps: StreamHubDeps) {
    this.manager = deps.manager;
    this.catalog = deps.catalog;
    this.branches = new FolderBranches((cwd, branch) =>
      this.broadcast({ type: "branch", cwd, branch }),
    );
    this.ready = this.refreshCatalog();
    deps.manager.on("agent", this.onAgent);
    deps.manager.on("closed", this.onClosed);
  }

  baseline(): BaselineFrame {
    return {
      type: "baseline",
      agents: this.manager.list(),
      sessions: this.sessions,
      branches: this.branches.current(),
    };
  }

  /**
   * Rescans the sessions dir and recomputes the window, broadcasting `catalog` when it differs
   * from the current one. Never rejects; a rescan finishing after a later one is dropped.
   */
  async refreshCatalog(): Promise<void> {
    const scan = ++this.scansStarted;
    let sessions: SessionSummary[];
    try {
      this.catalog.invalidate();
      sessions = await catalogWindow(this.catalog);
    } catch (e) {
      console.warn(`[stream] catalog scan failed: ${(e as Error).message}`);
      return;
    }
    if (scan < this.scanApplied) return;
    this.scanApplied = scan;
    if (JSON.stringify(sessions) === JSON.stringify(this.sessions)) return;
    this.sessions = sessions;
    this.broadcast({ type: "catalog", sessions });
  }

  /** Listens to every hub frame; returns the unsubscribe function. */
  subscribe(listener: (frame: HubFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Stops following the manager and closes the branch watches (shutdown). */
  close(): void {
    this.manager.off("agent", this.onAgent);
    this.manager.off("closed", this.onClosed);
    this.branches.close();
  }

  /** Tracks the branches of the folders with a live agent. */
  private syncBranches(): void {
    const cwds = new Set<string>();
    for (const agent of this.manager.list()) if (LIVE.has(agent.status)) cwds.add(agent.cwd);
    this.branches.sync(cwds);
  }

  private broadcast(frame: HubFrame): void {
    for (const listener of this.listeners) listener(frame);
  }
}
