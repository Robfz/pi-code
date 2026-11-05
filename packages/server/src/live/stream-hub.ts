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
import { type PrStore, prsView } from "../store/pr-store.ts";
import { type SidebarStateStore, sidebarView } from "../store/sidebar-state.ts";

/** Statuses of an agent whose pi process is running. */
const LIVE: ReadonlySet<AgentStatus> = new Set(["starting", "awaiting_trust", "ready"]);

type BaselineFrame = Extract<StreamFrame, { type: "baseline" }>;

/** Frames every connection receives, whatever it opened. */
type HubFrame = Extract<
  StreamFrame,
  { type: "agent" | "agent_closed" | "catalog" | "branch" | "sidebar" | "prs" }
>;

interface StreamHubDeps {
  manager: AgentManager;
  catalog: SessionCatalog;
  sidebar: SidebarStateStore;
  prs: PrStore;
}

/** Every session, in the catalog's order, as `StreamedSession`s. */
async function catalogListing(catalog: SessionCatalog): Promise<StreamedSession[]> {
  return (await catalog.sessions()).map(
    ({ ownedBy: _owner, updatedAt: _updated, ...session }) => session,
  );
}

/**
 * The live stream's shared inputs: turns manager events, catalog rescans, folder branches,
 * sidebar state and PR attachment changes into frames for every connection, and keeps the session
 * list, the branch map, the sidebar state and the PR attachments in memory, so baselines are built
 * without I/O beyond resolving the pinned repos' main checkouts (`sidebarView`).
 */
export class StreamHub {
  /** Resolves once the first session list is computed and the sidebar state and PRs loaded. */
  readonly ready: Promise<void>;
  private readonly manager: AgentManager;
  private readonly catalog: SessionCatalog;
  private readonly sidebar: SidebarStateStore;
  private readonly prs: PrStore;
  private readonly unsubscribeSidebar: () => void;
  private readonly unsubscribePrs: () => void;
  private sessions: StreamedSession[] = [];
  /** `sessions` as JSON, to compare rescans against. */
  private sessionsJson = "[]";
  private readonly branches: FolderBranches;
  private readonly listeners = new Set<(frame: HubFrame) => void>();
  /** Whether `drainScans` is running. */
  private scanning = false;
  /** Callers waiting for a rescan that hasn't started yet; non-empty means another is due. */
  private queued: (() => void)[] = [];
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
    this.prs = deps.prs;
    this.branches = new FolderBranches((cwd, branch) =>
      this.broadcast({ type: "branch", cwd, branch }),
    );
    this.unsubscribeSidebar = deps.sidebar.subscribe((sidebar) =>
      this.broadcast({ type: "sidebar", sidebar: sidebarView(sidebar) }),
    );
    this.unsubscribePrs = deps.prs.subscribe((prs) =>
      this.broadcast({ type: "prs", prs: prsView(prs) }),
    );
    this.ready = Promise.all([this.refreshCatalog(), deps.sidebar.ready, deps.prs.ready]).then(
      () => {},
    );
    deps.manager.on("agent", this.onAgent);
    deps.manager.on("closed", this.onClosed);
  }

  baseline(): BaselineFrame {
    return {
      type: "baseline",
      agents: this.manager.list(),
      sessions: this.sessions,
      branches: this.branches.current(),
      sidebar: sidebarView(this.sidebar.current()),
      prs: prsView(this.prs.current()),
    };
  }

  /**
   * Rescans the sessions dir, broadcasting `catalog` when the list differs from the current one,
   * and prunes the sidebar state of folders that are gone and the PRs of deleted sessions. Resolves once a rescan started after
   * the call has finished; never rejects. One rescan runs at a time: calls made meanwhile share
   * one follow-up rescan, so a burst of changes costs at most two.
   */
  refreshCatalog(): Promise<void> {
    const done = new Promise<void>((resolve) => this.queued.push(resolve));
    if (!this.scanning) void this.drainScans();
    return done;
  }

  private async drainScans(): Promise<void> {
    this.scanning = true;
    while (this.queued.length > 0) {
      const waiting = this.queued;
      this.queued = [];
      await this.rescan();
      for (const resolve of waiting) resolve();
    }
    this.scanning = false;
  }

  /** One rescan; never rejects, so `drainScans` always serves every queued caller. */
  private async rescan(): Promise<void> {
    void this.sidebar.prune().catch((e: unknown) => {
      console.warn(`[sidebar] prune failed: ${(e as Error).message}`);
    });
    void this.prs.prune().catch((e: unknown) => {
      console.warn(`[prs] prune failed: ${(e as Error).message}`);
    });
    try {
      // The listing may predate the change that asked for this rescan.
      this.catalog.invalidate();
      const sessions = await catalogListing(this.catalog);
      // One stringify per rescan, cheap next to the scan's stat of every session file.
      const json = JSON.stringify(sessions);
      if (json === this.sessionsJson) return;
      this.sessions = sessions;
      this.sessionsJson = json;
      this.broadcast({ type: "catalog", sessions });
    } catch (e) {
      console.warn(`[stream] catalog scan failed: ${(e as Error).message}`);
    }
  }

  /** Listens to every hub frame; returns the unsubscribe function. */
  subscribe(listener: (frame: HubFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Stops following the manager, the sidebar state and the PRs, and closes the branch watches
   * (shutdown).
   */
  close(): void {
    this.manager.off("agent", this.onAgent);
    this.manager.off("closed", this.onClosed);
    this.unsubscribeSidebar();
    this.unsubscribePrs();
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
