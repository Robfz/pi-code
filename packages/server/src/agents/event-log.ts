import type { SequencedEvent, ServerEvent } from "@pi-code/protocol";

type EventListener = (event: SequencedEvent) => void;

/** Default number of events kept per agent. */
const EVENT_LOG_CAPACITY = 10_000;

/**
 * Per-agent event log: assigns the monotonic `seq`, keeps the last `capacity` events for
 * replay, and fans each appended event out to subscribers synchronously.
 */
export class EventLog {
  readonly capacity: number;
  private items: SequencedEvent[] = [];
  /** Index of the oldest kept event in `items` (older ones are dropped lazily). */
  private start = 0;
  private lastSeq = 0;
  private readonly listeners = new Set<EventListener>();
  private readonly closeListeners = new Set<() => void>();
  private _closed = false;

  constructor(capacity = EVENT_LOG_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
    this.capacity = capacity;
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
  append(event: ServerEvent): SequencedEvent {
    this.lastSeq += 1;
    const sequenced: SequencedEvent = { seq: this.lastSeq, event };
    this.items.push(sequenced);
    if (this.items.length - this.start > this.capacity) {
      this.start += 1;
      if (this.start >= this.capacity) {
        this.items = this.items.slice(this.start);
        this.start = 0;
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(sequenced);
      } catch (e) {
        console.error("[event-log] listener failed:", e);
      }
    }
    return sequenced;
  }

  /**
   * Events after `since`, or `undefined` when they can't be replayed: `since` is not a
   * non-negative integer, is ahead of the log, or its successor was already dropped.
   */
  since(since: number): SequencedEvent[] | undefined {
    if (!Number.isInteger(since) || since < 0 || since > this.lastSeq) return undefined;
    const kept = this.items.length - this.start;
    const oldest = this.lastSeq - kept + 1;
    if (since + 1 < oldest) return undefined;
    return this.items.slice(this.start + (since + 1 - oldest));
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
}
