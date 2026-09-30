/**
 * Live conversation store (`docs/design/03-web-client.md`, "Live conversation store").
 *
 * One vanilla Zustand store per open agent. `hydrate` replaces everything with a snapshot;
 * `apply` runs each streamed event through the shared reducers (`reduceLive` for the live half,
 * `applyServerEventToCaches` for the committed half), exactly like the server does, so a
 * snapshot at `seq` plus the events after it equals the server's state.
 */

import {
  type AgentId,
  type AgentInfo,
  applyServerEventToCaches,
  initialLiveState,
  type LiveState,
  reduceLive,
  type ServerEvent,
  type SessionCaches,
  type Snapshot,
} from "@pi-code/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

export interface ConversationData extends SessionCaches {
  agentId: AgentId;
  live: LiveState;
  /** Last applied event (the `event` frame's `seq`, or the snapshot's). */
  seq: number;
  /** A snapshot has been applied at least once. */
  hydrated: boolean;
  connection: ConnectionState;
  /** The agent is gone (closed, or unknown to the server); the registry no longer feeds it. */
  closed: boolean;
}

export interface ConversationActions {
  hydrate(snapshot: Snapshot): void;
  /** Apply one event. Events at or below the current `seq` are ignored (replays). */
  apply(event: ServerEvent, seq: number): void;
  setConnection(connection: ConnectionState): void;
  markClosed(): void;
}

export type ConversationState = ConversationData & ConversationActions;
export type ConversationStore = StoreApi<ConversationState>;

/** Agent placeholder until the first snapshot arrives. */
export function placeholderAgent(id: AgentId): AgentInfo {
  return {
    id,
    cwd: "",
    status: "starting",
    isStreaming: false,
    attention: "none",
    startedAt: new Date(0).toISOString(),
  };
}

export function createConversationStore(
  agentId: AgentId,
  initial: Partial<ConversationData> = {},
): ConversationStore {
  return createStore<ConversationState>()((set, get) => ({
    agentId,
    agent: placeholderAgent(agentId),
    state: null,
    transcript: { entries: [], leafId: null },
    stats: null,
    gitStatus: null,
    live: initialLiveState(),
    seq: 0,
    hydrated: false,
    connection: "connecting",
    closed: false,
    ...initial,

    hydrate(snapshot) {
      set({
        agent: snapshot.agent,
        state: snapshot.state,
        transcript: snapshot.transcript,
        stats: snapshot.stats,
        gitStatus: snapshot.gitStatus,
        live: snapshot.live,
        seq: snapshot.seq,
        hydrated: true,
      });
    },

    apply(event, seq) {
      const current = get();
      if (seq <= current.seq) return;
      const live = reduceLive(current.live, event);
      const caches = applyServerEventToCaches(current, event);
      const patch: Partial<ConversationData> = { seq };
      if (live !== current.live) patch.live = live;
      if (caches !== current) {
        if (caches.agent !== current.agent) patch.agent = caches.agent;
        if (caches.state !== current.state) patch.state = caches.state;
        if (caches.transcript !== current.transcript) patch.transcript = caches.transcript;
        if (caches.stats !== current.stats) patch.stats = caches.stats;
        if (caches.gitStatus !== current.gitStatus) patch.gitStatus = caches.gitStatus;
      }
      set(patch);
    },

    setConnection(connection) {
      if (get().connection !== connection) set({ connection });
    },

    markClosed() {
      set({ closed: true });
    },
  }));
}
