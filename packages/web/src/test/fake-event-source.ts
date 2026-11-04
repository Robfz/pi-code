import type { AgentInfo, CursorList, StreamFrame } from "@pi-code/protocol";
import { act } from "@testing-library/react";
import type { EventSourceLike } from "@/store/live-registry";

/**
 * A scriptable `EventSource` (installed as the global one in `setup.ts`): tests drive the
 * connection (`open`, `drop`, `fail`) and push frames with `send`.
 */
export class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];

  static latest(): FakeEventSource {
    const es = FakeEventSource.instances.at(-1);
    if (!es) throw new Error("no EventSource");
    return es;
  }

  readyState = 0;
  onopen: EventSourceLike["onopen"] = null;
  onmessage: EventSourceLike["onmessage"] = null;
  onerror: EventSourceLike["onerror"] = null;
  closed = false;
  /** The last `id:` received: what the browser sends as `Last-Event-ID` when it reconnects. */
  lastEventId = "";
  private pingListeners = new Set<() => void>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  /** The URL's `open` cursors (`""` when absent). */
  get cursors(): CursorList {
    return new URL(this.url, "http://localhost").searchParams.get("open") ?? "";
  }

  addEventListener(_type: "ping", listener: () => void) {
    this.pingListeners.add(listener);
  }

  removeEventListener(_type: "ping", listener: () => void) {
    this.pingListeners.delete(listener);
  }

  open() {
    this.readyState = 1;
    this.onopen?.call(undefined as never, new Event("open"));
  }

  send(frame: StreamFrame, id?: CursorList) {
    if (id !== undefined) this.lastEventId = id;
    const message = new MessageEvent("message", {
      data: JSON.stringify(frame),
      lastEventId: this.lastEventId,
    });
    this.onmessage?.call(undefined as never, message);
  }

  /** The server's `event: ping` keep-alive. */
  ping() {
    for (const listener of this.pingListeners) listener();
  }

  /** Transient error: the browser keeps reconnecting. */
  drop() {
    this.readyState = 0;
    this.onerror?.call(undefined as never, new Event("error"));
  }

  /** Fatal error: the browser gave up. */
  fail() {
    this.readyState = 2;
    this.onerror?.call(undefined as never, new Event("error"));
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

/** Opens the app's current stream and sends `frame` (inside `act`, for rendered apps). */
export function sendFrame(frame: StreamFrame) {
  act(() => {
    const es = FakeEventSource.latest();
    if (es.readyState !== 1) es.open();
    es.send(frame);
  });
}

/** A baseline listing `agents`, with no sessions, branches, pins or collapsed groups. */
export function sendBaseline(agents: AgentInfo[]) {
  sendFrame({
    type: "baseline",
    agents,
    sessions: [],
    branches: {},
    sidebar: { pinned: [], collapsed: [], mains: {} },
    prs: {},
  });
}
