import type { ServerEvent } from "@pi-code/protocol";

/**
 * A logged event, kept only as its JSON: serialised once for every stream, and held once, so
 * `maxBytes` measures what the log actually keeps.
 */
export interface LoggedEvent {
  readonly seq: number;
  /** `JSON.stringify(event)`. */
  readonly json: string;
}

type EventListener = (event: LoggedEvent) => void;

/** Default number of events kept per agent. */
const EVENT_LOG_CAPACITY = 10_000;

/**
 * Default bound on the kept events' size, measured as the length of their JSON (about bytes:
 * the payloads are mostly ASCII). Text deltas average a few hundred bytes, so ordinary turns hit
 * the count first; this bounds runs of large events, such as pi's bash tool sending its output so
 * far (up to 50 KB) every 100 ms, which would otherwise keep hundreds of MB per agent. 32 MB
 * still replays a minute of such updates; a client further behind resyncs from a snapshot.
 */
const EVENT_LOG_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Per-agent event log: assigns the monotonic `seq`, keeps the last events for replay (at most
 * `capacity` of them and `maxBytes` of JSON, evicting the oldest), and fans each appended event
 * out to subscribers synchronously.
 */
export class EventLog {
  readonly capacity: number;
  private readonly maxBytes: number;
  /** Kept events from `start` on; evicted slots before it are cleared until compaction. */
  private items: (LoggedEvent | undefined)[] = [];
  private start = 0;
  /** JSON length of the kept events. */
  private bytes = 0;
  private lastSeq = 0;
  private readonly listeners = new Set<EventListener>();
  private readonly closeListeners = new Set<() => void>();
  private _closed = false;

  constructor(capacity = EVENT_LOG_CAPACITY, maxBytes = EVENT_LOG_MAX_BYTES) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
    this.capacity = capacity;
    this.maxBytes = maxBytes;
  }

  /** Seq of the last appended event (0 before any). */
  get seq(): number {
    return this.lastSeq;
  }

  /** Whether the agent is gone (streams should end). */
  get closed(): boolean {
    return this._closed;
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  /** Assigns the next seq, stores the event, and notifies subscribers. */
  append(event: ServerEvent): LoggedEvent {
    this.lastSeq += 1;
    const logged: LoggedEvent = { seq: this.lastSeq, json: JSON.stringify(event) };
    this.items.push(logged);
    this.bytes += logged.json.length;
    while (this.items.length - this.start > this.capacity || this.bytes > this.maxBytes) {
      this.evictOldest();
    }
    for (const listener of this.listeners) {
      try {
        listener(logged);
      } catch (e) {
        console.error("[event-log] listener failed:", e);
      }
    }
    return logged;
  }

  /**
   * Events after `since`, or `undefined` when they can't be replayed: `since` is not a
   * non-negative integer, is ahead of the log, or its successor was already dropped.
   */
  since(since: number): LoggedEvent[] | undefined {
    if (!Number.isInteger(since) || since < 0 || since > this.lastSeq) return undefined;
    const kept = this.items.length - this.start;
    const oldest = this.lastSeq - kept + 1;
    if (since + 1 < oldest) return undefined;
    return this.items.slice(this.start + (since + 1 - oldest)) as LoggedEvent[];
  }

  /** `onClose` runs when the log is closed (the agent was removed). */
  subscribe(listener: EventListener, onClose?: () => void): () => void {
    this.listeners.add(listener);
    if (onClose) this.closeListeners.add(onClose);
    return () => {
      this.listeners.delete(listener);
      if (onClose) this.closeListeners.delete(onClose);
    };
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    for (const listener of [...this.closeListeners]) listener();
  }

  private evictOldest(): void {
    const oldest = this.items[this.start] as LoggedEvent;
    this.bytes -= oldest.json.length;
    // Cleared now so a large evicted event is freed before the next compaction.
    this.items[this.start] = undefined;
    this.start += 1;
    if (this.start >= this.capacity) {
      this.items = this.items.slice(this.start);
      this.start = 0;
    }
  }
}
