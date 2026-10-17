/**
 * The tab's live state (`docs/design/05-desktop.md`, "Live registry"): one `GET /api/stream`
 * EventSource feeds the `live` overview (agents, session window, branches) and every opened
 * conversation store.
 *
 * - `open(id)` creates the store, fetches its snapshot, hydrates, then reconnects the stream
 *   with every hydrated store at its `seq`. Every hydrate reconnects.
 * - `resync`, or an `agent_status` turning the agent `ready`, refetches that store the same way.
 *   Until it's hydrated again it ignores its frames and is left out of reconnect URLs; what it
 *   missed replays after the reconnect that follows its hydrate.
 * - `event` frames are buffered per store and applied once per animation frame, in one store
 *   update each. A hidden tab gets no animation frames, so a `FLUSH_TIMEOUT_MS` timer and
 *   `visibilitychange` flush too. Every other frame, stream error or close, and every reconnect,
 *   flushes first, so effects keep the stream's order. Each event's side effects (the ready
 *   refetch, the `git_status` invalidation) run as it is applied. A refetch discards the
 *   store's buffer: its snapshot supersedes it.
 * - Stores off screen (released) stay open, so going back to a conversation doesn't refetch it,
 *   until a hydrate reconnects the stream anyway: then all but the `KEEP_RELEASED` most recently
 *   used (opened, or left the screen) are evicted, leaving the cursor list without an extra
 *   reconnect. An evicted store isn't closed; opening its agent again creates a new one from a
 *   snapshot.
 * - EventSource reconnects by itself (with `Last-Event-ID`) after transient errors; when it gives
 *   up (`CLOSED`) the registry reconnects with a backoff, as it retries failed snapshots. On
 *   visible, window `focus` or `online`, a closed stream or one silent for `STALE_AFTER_MS` (the
 *   server pings every 15 s, so it's a dead one the browser hasn't noticed) is reopened.
 * - An applied `git_status` event, or a hydrate, invalidates the agent's review queries.
 * - Snapshots don't clear attention: the conversation on screen (`show`) is acked on show, on
 *   `visibilitychange` to visible, on window `focus`, and when an `agent` frame raises its
 *   attention while the page is visible and focused.
 * - The sidebar state (pins, collapsed groups) lives on the server: `setSidebar` applies a change
 *   at once and sends it; `sidebar` frames, this tab's own changes included, replace it.
 */

import {
  type AgentId,
  type AgentInfo,
  applySidebarPatch,
  type SequencedEvent,
  SIDEBAR_KEYS,
  type SidebarPatch,
  type SidebarState,
  type SidebarView,
  type Snapshot,
  type StreamedSession,
  type StreamFrame,
} from "@pi-code/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ackAgent, getSnapshot, isApiRequestError, patchSidebar, streamUrl } from "@/lib/api";
import { queryKeys } from "@/lib/query-client";
import {
  type ConnectionState,
  type ConversationStore,
  createConversationStore,
} from "./conversation-store";

/** The subset of `EventSource` the registry uses. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((this: never, ev: Event) => unknown) | null;
  onmessage: ((this: never, ev: MessageEvent<string>) => unknown) | null;
  onerror: ((this: never, ev: Event) => unknown) | null;
  /** Named events; the registry listens for the server's `ping` keep-alive. */
  addEventListener(type: "ping", listener: () => void): void;
  removeEventListener(type: "ping", listener: () => void): void;
  close(): void;
}

const EVENT_SOURCE_CLOSED = 2;

/** A stream silent for this long (≥ 2 missed pings) is treated as dead when the page shows. */
export const STALE_AFTER_MS = 35_000;

/** Read by the sidebar, Home, the badge and the share screen. */
export interface LiveOverview {
  /** False until the first baseline: `agents` is empty because nothing is known yet. */
  loaded: boolean;
  agents: Record<AgentId, AgentInfo>;
  /** Every session, most recently prompted first. */
  sessions: StreamedSession[];
  /** cwd → branch, for folders with a live agent. */
  branches: Record<string, string>;
  sidebar: SidebarView;
  connection: ConnectionState;
}

export interface RegistryDeps {
  fetchSnapshot(agentId: AgentId): Promise<Snapshot>;
  ack(agentId: AgentId): Promise<void>;
  patchSidebar(patch: SidebarPatch): Promise<SidebarView>;
  document: Pick<
    Document,
    "visibilityState" | "hasFocus" | "addEventListener" | "removeEventListener"
  >;
  window: Pick<
    Window,
    "addEventListener" | "removeEventListener" | "requestAnimationFrame" | "cancelAnimationFrame"
  > & {
    navigator: { onLine: boolean };
  };
}

/** Longest an event waits to be applied when animation frames don't come (hidden tab). */
export const FLUSH_TIMEOUT_MS = 100;

/**
 * Released stores kept open: enough to go back and forth between the last few conversations
 * without a snapshot fetch, while each kept store costs its transcript in memory and its events
 * in every stream and replay.
 */
export const KEEP_RELEASED = 3;

/** Backoff between failed attempts, in ms; the last value repeats. */
const RETRY_DELAYS = [1_000, 2_000, 5_000, 10_000] as const;

function defaultRegistryDeps(): RegistryDeps {
  return {
    fetchSnapshot: getSnapshot,
    ack: ackAgent,
    patchSidebar,
    document,
    window,
  };
}

interface Opened {
  store: ConversationStore;
  /** Snapshot in flight or awaiting a retry: frames are ignored, the cursor left out of URLs. */
  refetching: boolean;
  /** Bumped by every refetch (and by `stop`), so a stale snapshot response is dropped. */
  generation: number;
  failures: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Events received and not yet applied. */
  pending: SequencedEvent[];
  /** When it was last opened or left the screen, on the registry's `clock`. */
  usedAt: number;
}

export class LiveRegistry {
  readonly live: StoreApi<LiveOverview> = createStore<LiveOverview>()(() => ({
    loaded: false,
    agents: {},
    sessions: [],
    branches: {},
    sidebar: { pinned: [], collapsed: [], mains: {} },
    connection: "connecting",
  }));
  private readonly queryClient: Pick<QueryClient, "invalidateQueries">;
  private readonly deps: RegistryDeps;
  private readonly opened = new Map<AgentId, Opened>();
  private running = false;
  private es: EventSourceLike | null = null;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the current stream last showed signs of life (open, message or ping). */
  private lastMessageAt = 0;
  private onScreen: AgentId | undefined;
  private flushFrame: number | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Orders opens and departures from the screen, for eviction. */
  private clock = 0;

  constructor(
    queryClient: Pick<QueryClient, "invalidateQueries">,
    deps: Partial<RegistryDeps> = {},
  ) {
    this.queryClient = queryClient;
    this.deps = { ...defaultRegistryDeps(), ...deps };
  }

  /** Opens the stream and fetches the snapshot of every store opened while stopped. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.deps.document.addEventListener("visibilitychange", this.onVisibility);
    this.deps.window.addEventListener("focus", this.onFocus);
    this.deps.window.addEventListener("online", this.onOnline);
    this.deps.window.addEventListener("offline", this.onOffline);
    for (const entry of this.opened.values()) if (entry.refetching) this.refetch(entry);
    this.reconnect();
  }

  /** Closes the stream; opened stores stay (a later `start` resumes them). */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.closeStream();
    for (const entry of this.opened.values()) {
      entry.generation++;
      clearTimeout(entry.retryTimer);
    }
    this.deps.document.removeEventListener("visibilitychange", this.onVisibility);
    this.deps.window.removeEventListener("focus", this.onFocus);
    this.deps.window.removeEventListener("online", this.onOnline);
    this.deps.window.removeEventListener("offline", this.onOffline);
    this.setStreamState("connecting");
  }

  /** The agent's store, created and loaded on first call. */
  open(agentId: AgentId): ConversationStore {
    const existing = this.opened.get(agentId);
    if (existing) {
      existing.usedAt = ++this.clock;
      return existing.store;
    }
    const entry: Opened = {
      store: createConversationStore(agentId),
      refetching: true,
      generation: 0,
      failures: 0,
      retryTimer: undefined,
      pending: [],
      usedAt: ++this.clock,
    };
    this.opened.set(agentId, entry);
    this.refetch(entry);
    return entry.store;
  }

  /** Forgets the agent's store and marks it closed (the agent is gone). */
  drop(agentId: AgentId): void {
    const entry = this.opened.get(agentId);
    if (!entry) return;
    this.forget(entry);
    entry.store.getState().markClosed();
  }

  /**
   * Marks the conversation on screen, which keeps its store from eviction, and acks it; returns
   * the cleanup for when it leaves.
   */
  show(agentId: AgentId): () => void {
    this.onScreen = agentId;
    this.ack(agentId);
    return () => {
      if (this.onScreen === agentId) this.onScreen = undefined;
      const entry = this.opened.get(agentId);
      if (entry) entry.usedAt = ++this.clock;
    };
  }

  /**
   * Sets pinned / collapsed flags per path, on screen at once, then as the server answers (it
   * skips a folder that is gone). A refusal puts the flags back and rejects.
   */
  async setSidebar(patch: SidebarPatch): Promise<void> {
    const adopt = (state: SidebarState) =>
      this.live.setState((s) => ({ sidebar: applySidebarPatch(s.sidebar, flagsIn(state, patch)) }));
    const before = this.live.getState().sidebar;
    this.live.setState((s) => ({ sidebar: applySidebarPatch(s.sidebar, patch) }));
    try {
      adopt(await this.deps.patchSidebar(patch));
    } catch (error) {
      adopt(before);
      throw error;
    }
  }

  /** Uncollapses the groups holding `paths`; asks the server only when one is collapsed. */
  expand(paths: readonly string[]): void {
    const { collapsed } = this.live.getState().sidebar;
    const shut = paths.filter((path) => collapsed.includes(path));
    if (shut.length === 0) return;
    this.setSidebar({
      collapsed: Object.fromEntries(shut.map((path) => [path, false])),
    }).catch(() => {});
  }

  private refetch(entry: Opened): void {
    const generation = ++entry.generation;
    entry.refetching = true;
    entry.pending = [];
    clearTimeout(entry.retryTimer);
    if (!this.running) return;
    const { store } = entry;
    const agentId = store.getState().agentId;
    const current = () => generation === entry.generation && this.opened.get(agentId) === entry;
    store.getState().setConnection(this.isOffline() ? "offline" : "connecting");
    this.deps.fetchSnapshot(agentId).then(
      (snapshot) => {
        if (!current()) return;
        entry.refetching = false;
        entry.failures = 0;
        store.getState().hydrate(snapshot);
        store.getState().setConnection(this.live.getState().connection);
        // Events dropped during the refetch may include a `git_status`.
        this.invalidateReview(agentId);
        this.evictReleased();
        this.reconnect();
      },
      (error: unknown) => {
        if (!current()) return;
        if (isApiRequestError(error, "agent_not_found")) {
          this.closeAgent(agentId);
          return;
        }
        store.getState().setConnection(this.failedState());
        entry.retryTimer = setTimeout(() => this.refetch(entry), this.delay(entry.failures++));
      },
    );
  }

  /** Evicts released stores (all but the one on screen) beyond the `KEEP_RELEASED` most recent. */
  private evictReleased(): void {
    const released = [...this.opened]
      .filter(([id]) => id !== this.onScreen)
      .map(([, entry]) => entry)
      .sort((a, b) => b.usedAt - a.usedAt);
    for (const entry of released.slice(KEEP_RELEASED)) this.forget(entry);
  }

  /** Stops feeding the entry's store; a snapshot in flight for it is dropped when it lands. */
  private forget(entry: Opened): void {
    clearTimeout(entry.retryTimer);
    entry.pending = [];
    this.opened.delete(entry.store.getState().agentId);
  }

  /** Replaces the stream with one opening every hydrated store at its `seq`. */
  private reconnect(): void {
    // Closing applies buffered events, so the cursors below include them.
    this.closeStream();
    if (!this.running) return;
    const cursors = [...this.opened]
      .filter(([, entry]) => !entry.refetching)
      .map(([id, entry]) => `${id}:${entry.store.getState().seq}`)
      .join(",");
    const es = new EventSource(streamUrl(cursors)) as unknown as EventSourceLike;
    this.es = es;
    this.lastMessageAt = Date.now();
    es.onopen = () => {
      this.lastMessageAt = Date.now();
      this.failures = 0;
    };
    es.onmessage = (message) => {
      this.lastMessageAt = Date.now();
      let frame: StreamFrame;
      try {
        frame = JSON.parse(message.data) as StreamFrame;
      } catch {
        return;
      }
      this.handleFrame(frame);
    };
    es.addEventListener("ping", this.onPing);
    es.onerror = () => {
      this.flushEvents();
      if (es.readyState === EVENT_SOURCE_CLOSED) {
        this.closeStream();
        this.setStreamState(this.failedState());
        this.retryTimer = setTimeout(() => this.reconnect(), this.delay(this.failures++));
      } else {
        // The browser retries on its own and resumes with Last-Event-ID.
        this.setStreamState(this.failedState());
      }
    };
  }

  private handleFrame(frame: StreamFrame): void {
    if (frame.type !== "event") this.flushEvents();
    switch (frame.type) {
      case "baseline": {
        const agents = Object.fromEntries(frame.agents.map((agent) => [agent.id, agent]));
        this.live.setState({
          loaded: true,
          agents,
          sessions: frame.sessions,
          branches: frame.branches,
          sidebar: frame.sidebar,
        });
        // A hydrated store's snapshot predates this stream (every hydrate reconnects), so its
        // absence means the agent is gone. A refetching store may be newer than the stream; its
        // snapshot tells.
        for (const [id, entry] of [...this.opened]) {
          if (!entry.refetching && agents[id] === undefined) this.closeAgent(id);
        }
        this.setStreamState("live");
        return;
      }
      case "event": {
        const entry = this.opened.get(frame.agentId);
        if (!entry || entry.refetching) return;
        entry.pending.push({ seq: frame.seq, event: frame.event });
        this.scheduleFlush();
        return;
      }
      case "resync": {
        const entry = this.opened.get(frame.agentId);
        if (entry && !entry.refetching) this.refetch(entry);
        return;
      }
      case "agent": {
        const { agent } = frame;
        const previous = this.live.getState().agents[agent.id]?.attention ?? "none";
        this.live.setState((s) => ({ agents: { ...s.agents, [agent.id]: agent } }));
        // Attention raised on the conversation being looked at: it has been seen.
        if (
          agent.id === this.onScreen &&
          agent.attention !== "none" &&
          agent.attention !== previous &&
          this.deps.document.visibilityState === "visible" &&
          this.deps.document.hasFocus()
        ) {
          this.ack(agent.id);
        }
        return;
      }
      case "agent_closed":
        this.closeAgent(frame.agentId);
        return;
      case "catalog":
        // Sent only when the list changes in something the session and project lists show.
        this.live.setState({ sessions: frame.sessions });
        void this.queryClient.invalidateQueries({ queryKey: ["sessions"] });
        void this.queryClient.invalidateQueries({ queryKey: queryKeys.projects });
        return;
      case "branch": {
        const { [frame.cwd]: _, ...branches } = this.live.getState().branches;
        if (frame.branch !== null) branches[frame.cwd] = frame.branch;
        this.live.setState({ branches });
        return;
      }
      case "sidebar":
        this.live.setState({ sidebar: frame.sidebar });
        return;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(this.flushEvents, FLUSH_TIMEOUT_MS);
    if (this.deps.document.visibilityState === "visible") {
      this.flushFrame = this.deps.window.requestAnimationFrame(this.flushEvents);
    }
  }

  /** Applies every store's buffered events, one store update each. */
  private readonly flushEvents = () => {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.flushFrame !== undefined) this.deps.window.cancelAnimationFrame(this.flushFrame);
    this.flushFrame = undefined;
    for (const entry of this.opened.values()) {
      if (entry.pending.length > 0) this.applyPending(entry);
    }
  };

  private applyPending(entry: Opened): void {
    const { store, pending } = entry;
    entry.pending = [];
    const agentId = store.getState().agentId;
    let becameReady = false;
    store.getState().applyBatch(pending, (event, before, after) => {
      if (event.type === "git_status") this.invalidateReview(agentId);
      // pi just became ready: the snapshot now has state, stats and the startup transcript.
      becameReady =
        event.type === "agent_status" &&
        before.agent.status !== "ready" &&
        after.agent.status === "ready";
      return becameReady;
    });
    // The events after it are left unapplied: the refetch supersedes them.
    if (becameReady) this.refetch(entry);
  }

  /** Every `git_status` follows a git refresh, changed or not: the review queries refetch. */
  private invalidateReview(agentId: AgentId): void {
    void this.queryClient.invalidateQueries({ queryKey: queryKeys.review(agentId) });
  }

  private closeAgent(agentId: AgentId): void {
    if (this.live.getState().agents[agentId] !== undefined) {
      this.live.setState((s) => {
        const { [agentId]: _, ...agents } = s.agents;
        return { agents };
      });
    }
    this.drop(agentId);
  }

  /** The stream's state, mirrored by every store not loading its own snapshot. */
  private setStreamState(connection: ConnectionState): void {
    if (this.live.getState().connection !== connection) this.live.setState({ connection });
    for (const entry of this.opened.values()) {
      if (!entry.refetching) entry.store.getState().setConnection(connection);
    }
  }

  private closeStream(): void {
    this.flushEvents();
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const es = this.es;
    if (es === null) return;
    this.es = null;
    es.onopen = null;
    es.onmessage = null;
    es.onerror = null;
    es.removeEventListener("ping", this.onPing);
    es.close();
  }

  private ack(agentId: AgentId): void {
    this.deps.ack(agentId).catch(() => {});
  }

  private delay(failures: number): number {
    return RETRY_DELAYS[Math.min(failures, RETRY_DELAYS.length - 1)] ?? 1_000;
  }

  private isOffline(): boolean {
    return this.deps.window.navigator.onLine === false;
  }

  /** The state of a connection or snapshot that failed and is being retried. */
  private failedState(): ConnectionState {
    return this.isOffline() ? "offline" : "reconnecting";
  }

  /** Reopens a stream that is closed (or waiting to retry) or went silent. */
  private reopenIfDead(): void {
    if (!this.running) return;
    const closed = this.es === null || this.es.readyState === EVENT_SOURCE_CLOSED;
    if (closed || Date.now() - this.lastMessageAt > STALE_AFTER_MS) {
      this.failures = 0;
      this.reconnect();
    }
  }

  private readonly onPing = () => {
    this.lastMessageAt = Date.now();
  };

  /** The user is back (page visible or window focused). */
  private resume(): void {
    this.reopenIfDead();
    if (this.onScreen !== undefined) this.ack(this.onScreen);
  }

  private readonly onVisibility = () => {
    this.flushEvents();
    if (this.deps.document.visibilityState === "visible") this.resume();
  };

  private readonly onFocus = () => {
    this.resume();
  };

  private readonly onOnline = () => {
    this.reopenIfDead();
  };

  private readonly onOffline = () => {
    this.setStreamState("offline");
  };
}

/** `patch`'s paths, flagged as they are in `state`. */
function flagsIn(state: SidebarState, patch: SidebarPatch): SidebarPatch {
  const flags: SidebarPatch = {};
  for (const key of SIDEBAR_KEYS) {
    const paths = Object.keys(patch[key] ?? {});
    if (paths.length > 0) {
      flags[key] = Object.fromEntries(paths.map((path) => [path, state[key].includes(path)]));
    }
  }
  return flags;
}
