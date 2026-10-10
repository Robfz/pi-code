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
 * - EventSource reconnects by itself (with `Last-Event-ID`) after transient errors; when it gives
 *   up (`CLOSED`) the registry reconnects with a backoff, as it retries failed snapshots. On
 *   visible, window `focus` or `online`, a closed stream or one silent for `STALE_AFTER_MS` (the
 *   server pings every 15 s, so it's a dead one the browser hasn't noticed) is reopened.
 * - An applied `git_status` event, or a hydrate, invalidates the agent's review queries.
 * - Snapshots don't clear attention: the conversation on screen (`show`) is acked on show, on
 *   `visibilitychange` to visible, on window `focus`, and when an `agent` frame raises its
 *   attention while the page is visible and focused.
 */

import type { AgentId, AgentInfo, SessionSummary, Snapshot, StreamFrame } from "@pi-code/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ackAgent, getSnapshot, isApiRequestError, streamUrl } from "@/lib/api";
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

/** Read by Home, the badge and the share screen. */
export interface LiveOverview {
  /** False until the first baseline: `agents` is empty because nothing is known yet. */
  loaded: boolean;
  agents: Record<AgentId, AgentInfo>;
  /** Sessions updated within the last 7 days, most recent first. */
  sessions: SessionSummary[];
  /** cwd → branch, for folders with a live agent. */
  branches: Record<string, string>;
  connection: ConnectionState;
}

export interface RegistryDeps {
  fetchSnapshot(agentId: AgentId): Promise<Snapshot>;
  ack(agentId: AgentId): Promise<void>;
  document: Pick<
    Document,
    "visibilityState" | "hasFocus" | "addEventListener" | "removeEventListener"
  >;
  window: Pick<Window, "addEventListener" | "removeEventListener"> & {
    navigator: { onLine: boolean };
  };
}

/** Backoff between failed attempts, in ms; the last value repeats. */
const RETRY_DELAYS = [1_000, 2_000, 5_000, 10_000] as const;

function defaultRegistryDeps(): RegistryDeps {
  return {
    fetchSnapshot: getSnapshot,
    ack: ackAgent,
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
}

export class LiveRegistry {
  readonly live: StoreApi<LiveOverview> = createStore<LiveOverview>()(() => ({
    loaded: false,
    agents: {},
    sessions: [],
    branches: {},
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
    if (existing) return existing.store;
    const entry: Opened = {
      store: createConversationStore(agentId),
      refetching: true,
      generation: 0,
      failures: 0,
      retryTimer: undefined,
    };
    this.opened.set(agentId, entry);
    this.refetch(entry);
    return entry.store;
  }

  /** Forgets the agent's store and marks it closed (the agent is gone). */
  drop(agentId: AgentId): void {
    const entry = this.opened.get(agentId);
    if (!entry) return;
    clearTimeout(entry.retryTimer);
    this.opened.delete(agentId);
    entry.store.getState().markClosed();
  }

  /** Marks the conversation on screen and acks it; returns the cleanup for when it leaves. */
  show(agentId: AgentId): () => void {
    this.onScreen = agentId;
    this.ack(agentId);
    return () => {
      if (this.onScreen === agentId) this.onScreen = undefined;
    };
  }

  private refetch(entry: Opened): void {
    const generation = ++entry.generation;
    entry.refetching = true;
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

  /** Replaces the stream with one opening every hydrated store at its `seq`. */
  private reconnect(): void {
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
    switch (frame.type) {
      case "baseline": {
        const agents = Object.fromEntries(frame.agents.map((agent) => [agent.id, agent]));
        this.live.setState({
          loaded: true,
          agents,
          sessions: frame.sessions,
          branches: frame.branches,
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
        const { store } = entry;
        const wasReady = store.getState().agent.status === "ready";
        store.getState().apply(frame.event, frame.seq);
        if (frame.event.type === "git_status") this.invalidateReview(frame.agentId);
        // pi just became ready: the snapshot now has state, stats and the startup transcript.
        if (
          frame.event.type === "agent_status" &&
          !wasReady &&
          store.getState().agent.status === "ready"
        ) {
          this.refetch(entry);
        }
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
      case "catalog": {
        // Every session write sends one. The session and project lists are refetched when what
        // they show changes (a session added, gone, renamed, titled or opened) or their order
        // does (a session moving to the top), not when only `updatedAt` moves.
        const previous = this.live.getState().sessions;
        this.live.setState({ sessions: frame.sessions });
        if (!sameListing(previous, frame.sessions)) {
          void this.queryClient.invalidateQueries({ queryKey: ["sessions"] });
          void this.queryClient.invalidateQueries({ queryKey: queryKeys.projects });
        }
        return;
      }
      case "branch": {
        const { [frame.cwd]: _, ...branches } = this.live.getState().branches;
        if (frame.branch !== null) branches[frame.cwd] = frame.branch;
        this.live.setState({ branches });
        return;
      }
    }
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

/** What the session lists show of a session, bar its recency. */
function listing(session: SessionSummary): string {
  const { updatedAt: _, ...shown } = session;
  return JSON.stringify(shown);
}

/** Same sessions, showing the same, in the same order (most recent first). */
function sameListing(a: readonly SessionSummary[], b: readonly SessionSummary[]): boolean {
  return (
    a.length === b.length &&
    a.every((session, i) => listing(session) === listing(b[i] as SessionSummary))
  );
}
