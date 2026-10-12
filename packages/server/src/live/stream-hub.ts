import type {
  AgentId,
  AgentInfo,
  AgentStatus,
  StreamedSession,
  StreamFrame,
} from "@pi-code/protocol";
import type { AgentManager } from "../agents/agent-manager.ts";
import type { SessionCatalog } from "../catalog/sessions.ts";
import { FolderBranches } from "../git/branches.ts";
import type { SidebarStateStore } from "../store/sidebar-state.ts";

/** Statuses of an agent whose pi process is running. */
const LIVE: ReadonlySet<AgentStatus> = new Set(["starting", "awaiting_trust", "ready"]);

type BaselineFrame = Extract<StreamFrame, { type: "baseline" }>;

/** Frames every connection receives, whatever it opened. */
type HubFrame = Extract<
  StreamFrame,
  { type: "agent" | "agent_closed" | "catalog" | "branch" | "sidebar" }
>;

interface StreamHubDeps {
  manager: AgentManager;
  catalog: SessionCatalog;
  sidebar: SidebarStateStore;
}

/** Every session, in the catalog's order, as `StreamedSession`s. */
async function catalogListing(catalog: SessionCatalog): Promise<StreamedSession[]> {
  return (await catalog.sessions()).map(
    ({ ownedBy: _owner, updatedAt: _updated, ...session }) => session,
  );
}

/**
 * The live stream's shared inputs: turns manager events, catalog rescans, folder branches and
 * sidebar state changes into frames for every connection, and keeps the session list, the branch
 * map and the sidebar state in memory, so baselines are built without I/O.
 */
export class StreamHub {
  /** Resolves once the first session list is computed and the sidebar state loaded. */
  readonly ready: Promise<void>;
  private readonly manager: AgentManager;
  private readonly catalog: SessionCatalog;
  private readonly sidebar: SidebarStateStore;
  private readonly unsubscribeSidebar: () => void;
  private sessions: StreamedSession[] = [];
  private readonly branches: FolderBranches;
  private readonly listeners = new Set<(frame: HubFrame) => void>();
  /** Rescans started, and the latest one whose list was applied. */
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
    this.sidebar = deps.sidebar;
    this.branches = new FolderBranches((cwd, branch) =>
      this.broadcast({ type: "branch", cwd, branch }),
    );
    this.unsubscribeSidebar = deps.sidebar.subscribe((sidebar) =>
      this.broadcast({ type: "sidebar", sidebar }),
    );
    this.ready = Promise.all([this.refreshCatalog(), deps.sidebar.ready]).then(() => {});
    deps.manager.on("agent", this.onAgent);
    deps.manager.on("closed", this.onClosed);
  }

  baseline(): BaselineFrame {
    return {
      type: "baseline",
      agents: this.manager.list(),
      sessions: this.sessions,
      branches: this.branches.current(),
      sidebar: this.sidebar.current(),
    };
  }

  /**
   * Rescans the sessions dir, broadcasting `catalog` when the list differs from the current one,
   * and prunes the sidebar state of folders that are gone. Never rejects; a rescan finishing
   * after a later one is dropped.
   */
  async refreshCatalog(): Promise<void> {
    const scan = ++this.scansStarted;
    void this.sidebar.prune().catch((e: unknown) => {
      console.warn(`[sidebar] prune failed: ${(e as Error).message}`);
    });
    let sessions: StreamedSession[];
    try {
      this.catalog.invalidate();
      sessions = await catalogListing(this.catalog);
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

  /** Stops following the manager and the sidebar state, and closes the branch watches (shutdown). */
  close(): void {
    this.manager.off("agent", this.onAgent);
    this.manager.off("closed", this.onClosed);
    this.unsubscribeSidebar();
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
