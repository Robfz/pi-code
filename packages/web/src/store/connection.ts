/**
 * Connection lifecycle for one conversation store:
 *
 * 1. `GET /snapshot` → `hydrate`.
 * 2. `EventSource(/events?since=<seq>)`; each message → `apply(event, id)`.
 * 3. `resync` → close, back to 1.
 * 4. `visibilitychange` → visible: back to 1 if the EventSource is closed; `POST /ack`.
 * 5. `stop()` (unmount) → close.
 *
 * EventSource reconnects by itself (with `Last-Event-ID`) after transient errors; only when it
 * gives up (`readyState === CLOSED`) or the snapshot fails does this retry with a backoff.
 */

import type { ServerEvent, Snapshot } from "@pi-code/protocol";
import { ackAgent, eventsUrl, getSnapshot, isApiRequestError } from "@/lib/api";
import type { ConversationStore } from "./conversation-store";

/** The subset of `EventSource` the connection uses (so tests can inject a fake). */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((this: never, ev: Event) => unknown) | null;
  onmessage: ((this: never, ev: MessageEvent<string>) => unknown) | null;
  onerror: ((this: never, ev: Event) => unknown) | null;
  close(): void;
}

export const EVENT_SOURCE_CLOSED = 2;

export interface ConnectionDeps {
  fetchSnapshot(agentId: string): Promise<Snapshot>;
  ack(agentId: string): Promise<void>;
  createEventSource(url: string): EventSourceLike;
  eventsUrl(agentId: string, since: number): string;
  /** Backoff between failed attempts, in ms; the last value repeats. */
  retryDelays: readonly number[];
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  window: Pick<Window, "addEventListener" | "removeEventListener"> & {
    navigator: { onLine: boolean };
  };
}

export function defaultConnectionDeps(): ConnectionDeps {
  return {
    fetchSnapshot: getSnapshot,
    ack: ackAgent,
    createEventSource: (url) => new EventSource(url) as unknown as EventSourceLike,
    eventsUrl,
    retryDelays: [1_000, 2_000, 5_000, 10_000],
    document,
    window,
  };
}

/** Codes after which retrying can't help. */
const FATAL_CODES = new Set(["agent_not_found"]);

export class ConversationConnection {
  private readonly store: ConversationStore;
  private readonly deps: ConnectionDeps;
  private es: EventSourceLike | null = null;
  /** Bumped on every sync / stop, so stale async work can tell it's outdated. */
  private generation = 0;
  private syncing = false;
  private running = false;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(store: ConversationStore, deps: Partial<ConnectionDeps> = {}) {
    this.store = store;
    this.deps = { ...defaultConnectionDeps(), ...deps };
  }

  get agentId(): string {
    return this.store.getState().agentId;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.deps.document.addEventListener("visibilitychange", this.onVisibility);
    this.deps.window.addEventListener("online", this.onOnline);
    this.deps.window.addEventListener("offline", this.onOffline);
    void this.sync();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    this.syncing = false;
    this.closeEventSource();
    this.clearRetry();
    this.deps.document.removeEventListener("visibilitychange", this.onVisibility);
    this.deps.window.removeEventListener("online", this.onOnline);
    this.deps.window.removeEventListener("offline", this.onOffline);
  }

  /** Refetch the snapshot and reopen the stream (also used after restart). */
  async sync(): Promise<void> {
    if (!this.running) return;
    const generation = ++this.generation;
    this.syncing = true;
    this.closeEventSource();
    this.clearRetry();
    const store = this.store.getState();
    store.setConnection(
      this.isOffline() ? "offline" : store.hydrated ? "reconnecting" : "connecting",
    );
    try {
      const snapshot = await this.deps.fetchSnapshot(this.agentId);
      if (generation !== this.generation) return;
      this.syncing = false;
      this.store.getState().hydrate(snapshot);
      this.open(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.syncing = false;
      if (isApiRequestError(error) && FATAL_CODES.has(error.code)) {
        this.store.getState().setLoadError({ code: error.code, message: error.message });
        this.store.getState().setConnection("offline");
        return;
      }
      this.scheduleRetry();
    }
  }

  private open(generation: number): void {
    const since = this.store.getState().seq;
    const es = this.deps.createEventSource(this.deps.eventsUrl(this.agentId, since));
    this.es = es;
    es.onopen = () => {
      if (generation !== this.generation) return;
      this.failures = 0;
      this.store.getState().setConnection("live");
    };
    es.onmessage = (message) => {
      if (generation !== this.generation) return;
      this.handleMessage(message);
    };
    es.onerror = () => {
      if (generation !== this.generation) return;
      if (es.readyState === EVENT_SOURCE_CLOSED) {
        this.es = null;
        this.scheduleRetry();
      } else {
        // The browser retries on its own and resumes with Last-Event-ID.
        this.store.getState().setConnection(this.isOffline() ? "offline" : "reconnecting");
      }
    };
  }

  private handleMessage(message: MessageEvent<string>): void {
    let event: ServerEvent;
    try {
      event = JSON.parse(message.data) as ServerEvent;
    } catch {
      return;
    }
    if (event.type === "resync") {
      void this.sync();
      return;
    }
    const store = this.store.getState();
    const id = message.lastEventId;
    const seq =
      id !== undefined && id !== "" && Number.isFinite(Number(id)) ? Number(id) : store.seq + 1;
    const wasReady = store.agent.status === "ready";
    store.apply(event, seq);
    this.store.getState().setConnection("live");
    // pi just became ready: the snapshot now has state, stats and the startup transcript.
    if (event.type === "agent_status" && event.agent.status === "ready" && !wasReady) {
      void this.sync();
    }
  }

  private scheduleRetry(): void {
    if (!this.running) return;
    this.store.getState().setConnection(this.isOffline() ? "offline" : "reconnecting");
    const delays = this.deps.retryDelays;
    const delay = delays[Math.min(this.failures, delays.length - 1)] ?? 1_000;
    this.failures++;
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.sync();
    }, delay);
  }

  private closeEventSource(): void {
    if (this.es === null) return;
    const es = this.es;
    this.es = null;
    es.onopen = null;
    es.onmessage = null;
    es.onerror = null;
    es.close();
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private isOffline(): boolean {
    return this.deps.window.navigator.onLine === false;
  }

  private isClosed(): boolean {
    return this.es === null || this.es.readyState === EVENT_SOURCE_CLOSED;
  }

  private readonly onVisibility = () => {
    if (this.deps.document.visibilityState !== "visible") return;
    if (this.isClosed() && !this.syncing) {
      this.failures = 0;
      void this.sync();
    }
    this.deps.ack(this.agentId).catch(() => {});
  };

  private readonly onOnline = () => {
    if (this.isClosed() && !this.syncing) {
      this.failures = 0;
      void this.sync();
    }
  };

  private readonly onOffline = () => {
    this.store.getState().setConnection("offline");
  };
}
