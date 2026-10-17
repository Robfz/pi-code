/**
 * Live conversation store (`docs/design/03-web-client.md`, "Live conversation store").
 *
 * One vanilla Zustand store per open agent. `hydrate` replaces everything with a snapshot;
 * `applyBatch` runs streamed events through the shared reducers (`reduceLive` for the live half,
 * `applyServerEventToCaches` for the committed half), exactly like the server does, so a
 * snapshot at `seq` plus the events after it equals the server's state. A batch folds its events
 * and notifies subscribers once.
 */

import {
  type AgentId,
  type AgentInfo,
  applyServerEventToCaches,
  initialLiveState,
  type LiveState,
  reduceLive,
  type SequencedEvent,
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
  /**
   * Apply one event. Events at or below the current `seq` are ignored (replays). The registry
   * applies batches; this one-event form of `applyBatch` is what tests and fixtures drive.
   */
  apply(event: ServerEvent, seq: number): void;
  /**
   * Apply `events` in order with one update, ignoring replays as `apply` does. `visit` sees each
   * event (replays included) with the state before and after it; returning true stops the
   * batch after that event, leaving the rest unapplied.
   */
  applyBatch(events: readonly SequencedEvent[], visit?: BatchVisitor): void;
  setConnection(connection: ConnectionState): void;
  markClosed(): void;
}

export type BatchVisitor = (
  event: ServerEvent,
  before: ConversationData,
  after: ConversationData,
) => boolean;

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
        // Defaults for fields a server older than this bundle doesn't send.
        live: { ...initialLiveState(), ...snapshot.live },
        seq: snapshot.seq,
        hydrated: true,
      });
    },

    apply(event, seq) {
      get().applyBatch([{ event, seq }]);
    },

    applyBatch(events, visit) {
      const start = get();
      let current: ConversationData = start;
      for (const { event, seq } of events) {
        const before = current;
        if (seq > current.seq) {
          current = {
            ...applyServerEventToCaches(current, event),
            live: reduceLive(current.live, event),
            seq,
          };
        }
        if (visit?.(event, before, current)) break;
      }
      if (current === start) return;
      // Only changed slices: untouched ones keep their identity for selectors.
      const patch: Partial<ConversationData> = { seq: current.seq };
      if (current.live !== start.live) patch.live = current.live;
      if (current.agent !== start.agent) patch.agent = current.agent;
      if (current.state !== start.state) patch.state = current.state;
      if (current.transcript !== start.transcript) patch.transcript = current.transcript;
      if (current.stats !== start.stats) patch.stats = current.stats;
      if (current.gitStatus !== start.gitStatus) patch.gitStatus = current.gitStatus;
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
