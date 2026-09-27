import type { ServerEvent, Snapshot } from "@pi-code/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api";
import { fixtureEvents, makeAgent, makeSnapshot, reduceAll } from "@/test/fixtures";
import {
  type ConnectionDeps,
  ConversationConnection,
  type EventSourceLike,
  STALE_AFTER_MS,
} from "./connection";
import { createConversationStore } from "./conversation-store";

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: EventSourceLike["onopen"] = null;
  onmessage: EventSourceLike["onmessage"] = null;
  onerror: EventSourceLike["onerror"] = null;
  closed = false;
  private pingListeners: (() => void)[] = [];

  addEventListener(_type: "ping", listener: () => void) {
    this.pingListeners.push(listener);
  }

  /** The server's `event: ping` keep-alive. */
  ping() {
    for (const listener of this.pingListeners) listener();
  }

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.call(undefined as never, new Event("open"));
  }

  emit(event: ServerEvent, id?: number) {
    const message = new MessageEvent("message", {
      data: JSON.stringify(event),
      lastEventId: id === undefined ? "" : String(id),
    });
    this.onmessage?.call(undefined as never, message);
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

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  setVisibility(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

class FakeWindow extends EventTarget {
  navigator = { onLine: true };
}

const latest = () => {
  const es = FakeEventSource.instances.at(-1);
  if (!es) throw new Error("no EventSource");
  return es;
};

let snapshots: Snapshot[];
let fakeDocument: FakeDocument;
let fakeWindow: FakeWindow;
let deps: Partial<ConnectionDeps> & {
  fetchSnapshot: ReturnType<typeof vi.fn>;
  ack: ReturnType<typeof vi.fn>;
};

function setup() {
  const store = createConversationStore("a1");
  const connection = new ConversationConnection(store, deps);
  return { store, connection };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  snapshots = [makeSnapshot({ seq: 5 })];
  fakeDocument = new FakeDocument();
  fakeWindow = new FakeWindow();
  deps = {
    fetchSnapshot: vi.fn(async () => snapshots.shift() ?? makeSnapshot({ seq: 100 })),
    ack: vi.fn(async () => {}),
    createEventSource: (url) => new FakeEventSource(url),
    eventsUrl: (id, since) => `/api/agents/${id}/events?since=${since}`,
    retryDelays: [1_000, 5_000],
    document: fakeDocument as unknown as Document,
    window: fakeWindow as unknown as ConnectionDeps["window"],
    now: () => Date.now(),
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ConversationConnection", () => {
  it("hydrates from the snapshot, then streams from its seq", async () => {
    const { store, connection } = setup();
    connection.start();
    expect(store.getState().connection).toBe("connecting");
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(store.getState()).toMatchObject({ hydrated: true, seq: 5 });
    expect(latest().url).toBe("/api/agents/a1/events?since=5");

    latest().open();
    expect(store.getState().connection).toBe("live");

    const events = fixtureEvents("plain-answer");
    events.forEach((event, index) => {
      latest().emit(event, 6 + index);
    });
    expect(store.getState().live).toEqual(reduceAll(events));
    expect(store.getState().seq).toBe(5 + events.length);
    connection.stop();
  });

  it("drops events already covered by the snapshot", async () => {
    const { store, connection } = setup();
    connection.start();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    latest().emit({ type: "pi", event: { type: "agent_start" } }, 5);
    expect(store.getState().live.run.active).toBe(false);
    latest().emit({ type: "pi", event: { type: "agent_start" } }, 6);
    expect(store.getState().live.run.active).toBe(true);
    connection.stop();
  });

  it("on resync closes the stream, refetches the snapshot and reconnects from its seq", async () => {
    snapshots = [
      makeSnapshot({ seq: 5 }),
      makeSnapshot({ seq: 20, agent: makeAgent({ cwd: "/new" }) }),
    ];
    const { store, connection } = setup();
    connection.start();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const first = latest();
    first.open();
    first.emit({ type: "pi", event: { type: "agent_start" } }, 6);

    first.emit({ type: "resync" });
    expect(first.closed).toBe(true);
    expect(store.getState().connection).toBe("reconnecting");
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({ seq: 20, agent: { cwd: "/new" } });
    expect(store.getState().live.run.active).toBe(false); // replaced by the snapshot
    expect(latest().url).toBe("/api/agents/a1/events?since=20");

    // Late events from the old stream are ignored.
    first.onmessage?.call(
      undefined as never,
      new MessageEvent("message", {
        data: '{"type":"pi","event":{"type":"agent_start"}}',
        lastEventId: "21",
      }),
    );
    expect(store.getState().live.run.active).toBe(false);
    connection.stop();
  });

  it("lets EventSource retry transient errors, and resyncs after it gives up", async () => {
    vi.useFakeTimers();
    const { store, connection } = setup();
    connection.start();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    latest().open();

    latest().drop();
    expect(store.getState().connection).toBe("reconnecting");
    expect(FakeEventSource.instances).toHaveLength(1);
    latest().open();
    expect(store.getState().connection).toBe("live");

    latest().fail();
    expect(store.getState().connection).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(999);
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances).toHaveLength(2);
    connection.stop();
  });

  it("retries a failed snapshot with backoff", async () => {
    vi.useFakeTimers();
    deps.fetchSnapshot
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("network"));
    const { store, connection } = setup();
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().connection).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(3);
    expect(FakeEventSource.instances).toHaveLength(1);
    connection.stop();
  });

  it("stops retrying when the agent doesn't exist", async () => {
    deps.fetchSnapshot.mockRejectedValue(new ApiRequestError(404, "agent_not_found", "no agent"));
    const { store, connection } = setup();
    connection.start();
    await vi.waitFor(() => expect(store.getState().loadError?.code).toBe("agent_not_found"));
    expect(FakeEventSource.instances).toHaveLength(0);
    connection.stop();
  });

  it("on visible: reconnects if the stream is closed, and acks", async () => {
    vi.useFakeTimers();
    const { connection } = setup();
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    latest().open();

    fakeDocument.setVisibility("hidden");
    expect(deps.ack).not.toHaveBeenCalled();
    fakeDocument.setVisibility("visible");
    expect(deps.ack).toHaveBeenCalledWith("a1");
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(1); // stream still open

    latest().fail(); // e.g. the phone slept and the browser gave up
    fakeDocument.setVisibility("visible");
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(2); // immediately, not after the backoff
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(deps.ack).toHaveBeenCalledTimes(2);
    connection.stop();
  });

  it("on visible: resyncs a stream that went silent (no message or ping for 35 s)", async () => {
    vi.useFakeTimers();
    const { connection } = setup();
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    latest().open();

    // Pings keep a quiet stream alive.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      latest().ping();
    }
    fakeDocument.setVisibility("hidden");
    fakeDocument.setVisibility("visible");
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(1);

    // So do messages.
    await vi.advanceTimersByTimeAsync(30_000);
    latest().emit({ type: "pi", event: { type: "agent_start" } }, 6);
    await vi.advanceTimersByTimeAsync(30_000);
    fakeDocument.setVisibility("visible");
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(1);

    // The tab was suspended: the stream looks open but nothing arrived for too long.
    fakeDocument.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(STALE_AFTER_MS + 1);
    const stale = latest();
    fakeDocument.setVisibility("visible");
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(stale.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeEventSource.instances).toHaveLength(2);
    connection.stop();
  });

  it("acks attention raised while the conversation is visible", async () => {
    const { connection } = setup();
    connection.start();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    latest().open();
    latest().emit({ type: "agent_status", agent: makeAgent({ attention: "none" }) }, 6);
    expect(deps.ack).not.toHaveBeenCalled();
    latest().emit({ type: "agent_status", agent: makeAgent({ attention: "finished" }) }, 7);
    expect(deps.ack).toHaveBeenCalledWith("a1");

    fakeDocument.visibilityState = "hidden";
    latest().emit({ type: "agent_status", agent: makeAgent({ attention: "input" }) }, 8);
    expect(deps.ack).toHaveBeenCalledTimes(1);
    connection.stop();
  });

  it("resyncs when pi becomes ready", async () => {
    snapshots = [
      makeSnapshot({ seq: 1, agent: makeAgent({ status: "starting" }) }),
      makeSnapshot({ seq: 3, agent: makeAgent({ status: "ready" }) }),
    ];
    const { store, connection } = setup();
    connection.start();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    latest().emit({ type: "agent_status", agent: makeAgent({ status: "ready" }) }, 2);
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(store.getState().seq).toBe(3);
    connection.stop();
  });

  it("goes offline with the browser and reconnects when back online", async () => {
    const { store, connection } = setup();
    connection.start();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    latest().open();
    fakeWindow.navigator.onLine = false;
    fakeWindow.dispatchEvent(new Event("offline"));
    expect(store.getState().connection).toBe("offline");
    latest().fail();
    fakeWindow.navigator.onLine = true;
    fakeWindow.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    connection.stop();
  });

  it("stop closes the stream and ignores in-flight snapshots", async () => {
    let resolve: (s: Snapshot) => void = () => {};
    deps.fetchSnapshot.mockImplementationOnce(
      () =>
        new Promise<Snapshot>((r) => {
          resolve = r;
        }),
    );
    const { store, connection } = setup();
    connection.start();
    connection.stop();
    resolve(makeSnapshot({ seq: 9 }));
    await Promise.resolve();
    expect(store.getState().hydrated).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(0);

    connection.start();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    connection.stop();
    expect(latest().closed).toBe(true);
    fakeDocument.setVisibility("visible");
    expect(deps.ack).not.toHaveBeenCalled();
  });
});
