import type {
  AgentId,
  AgentInfo,
  CursorList,
  ServerEvent,
  SessionSummary,
  Snapshot,
  StreamFrame,
} from "@pi-code/protocol";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api";
import { FakeEventSource } from "@/test/fake-event-source";
import { fixtureEvents, makeAgent, makeSnapshot, reduceAll } from "@/test/fixtures";
import type { ConversationStore } from "./conversation-store";
import { LiveRegistry, type RegistryDeps, STALE_AFTER_MS } from "./live-registry";

function parseCursors(list: CursorList): Map<AgentId, number> {
  const cursors = new Map<AgentId, number>();
  for (const pair of list.split(",")) {
    const [id, seq] = pair.split(":");
    if (id && seq !== undefined) cursors.set(id, Number(seq));
  }
  return cursors;
}

/**
 * The server side of `GET /api/stream` over per-agent event logs, framed as in `http/stream.ts`:
 * baseline, then per opened agent a replay from its cursor (a `Last-Event-ID` cursor wins) or a
 * `resync`, then live events; every frame's `id:` is the connection's cursor list.
 */
class FakeServer {
  private readonly logs = new Map<AgentId, { events: ServerEvent[]; oldest: number }>();
  private connection:
    | { es: FakeEventSource; streamed: AgentId[]; cursors: Map<AgentId, number> }
    | undefined;

  add(id: AgentId) {
    this.logs.set(id, { events: [], oldest: 1 });
  }

  seq(id: AgentId): number {
    return this.log(id).events.length;
  }

  snapshot(id: AgentId): Snapshot {
    const { events } = this.log(id);
    return makeSnapshot({ agent: makeAgent({ id }), seq: events.length, live: reduceAll(events) });
  }

  /** The agent's ring buffer drops every event so far: older cursors resync. */
  trim(id: AgentId) {
    const log = this.log(id);
    log.oldest = log.events.length + 1;
  }

  /** Serves `es`: a new EventSource, or the browser reconnecting it with `Last-Event-ID`. */
  connect(es: FakeEventSource, lastEventId?: CursorList) {
    const opened = parseCursors(es.cursors);
    const resumed = parseCursors(lastEventId ?? "");
    const streamed = [...opened.keys()].filter((id) => this.logs.has(id));
    this.connection = { es, streamed, cursors: new Map() };
    es.open();
    const starts = streamed.map((id) => {
      const seq = resumed.get(id) ?? (opened.get(id) as number);
      const log = this.log(id);
      const replayable = seq >= log.oldest - 1 && seq <= log.events.length;
      if (replayable) this.connection?.cursors.set(id, seq);
      return { id, seq: replayable ? seq : undefined };
    });
    const agents = [...this.logs.keys()].map((id) => makeAgent({ id }));
    this.send({ type: "baseline", agents, sessions: [], branches: {} });
    for (const { id, seq } of starts) {
      if (seq === undefined) {
        this.connection.cursors.set(id, this.seq(id));
        this.send({ type: "resync", agentId: id });
      } else {
        for (let s = seq + 1; s <= this.seq(id); s++) this.sendEvent(id, s);
      }
    }
  }

  /** The connection drops; the browser keeps its EventSource and retries. */
  disconnect() {
    const es = this.connection?.es;
    this.connection = undefined;
    es?.drop();
  }

  push(id: AgentId, event: ServerEvent) {
    this.log(id).events.push(event);
    if (this.connection?.streamed.includes(id)) this.sendEvent(id, this.seq(id));
  }

  private sendEvent(id: AgentId, seq: number) {
    this.connection?.cursors.set(id, seq);
    const event = this.log(id).events[seq - 1] as ServerEvent;
    this.send({ type: "event", agentId: id, seq, event });
  }

  private send(frame: StreamFrame) {
    if (!this.connection) return;
    const { es, streamed, cursors } = this.connection;
    const ids = streamed
      .filter((id) => cursors.has(id))
      .map((id) => `${id}:${cursors.get(id)}`)
      .join(",");
    es.send(frame, ids);
  }

  private log(id: AgentId) {
    const log = this.logs.get(id);
    if (!log) throw new Error(`no agent ${id}`);
    return log;
  }
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  focused = true;
  hasFocus() {
    return this.focused;
  }
  setVisibility(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

class FakeWindow extends EventTarget {
  navigator = { onLine: true };
}

const latest = () => FakeEventSource.latest();
const openStreams = () => FakeEventSource.instances.filter((es) => !es.closed);
const flush = () =>
  vi.isFakeTimers()
    ? vi.advanceTimersByTimeAsync(0)
    : new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Records every change of the store's position: `h<seq>` for a hydrate, `<seq>` for an applied
 * event (replays at or below the current `seq` are no-ops and not recorded).
 */
function trackSeqs(store: ConversationStore): string[] {
  const log: string[] = [];
  const { hydrate, apply } = store.getState();
  store.setState({
    hydrate: (snapshot) => {
      log.push(`h${snapshot.seq}`);
      hydrate(snapshot);
    },
    apply: (event: ServerEvent, seq: number) => {
      if (seq > store.getState().seq) log.push(String(seq));
      apply(event, seq);
    },
  });
  return log;
}

/** Applied events that don't directly follow the previous position. */
function gaps(log: readonly string[]): string[] {
  const found: string[] = [];
  let seq = Number.NaN;
  for (const entry of log) {
    if (entry.startsWith("h")) {
      seq = Number(entry.slice(1));
    } else {
      if (Number(entry) !== seq + 1) found.push(`${seq} → ${entry}`);
      seq = Number(entry);
    }
  }
  return found;
}

const session = (id: string): SessionSummary => ({
  file: `/s/${id}.jsonl`,
  id,
  cwd: "/home/me/project",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
});

const agentFrame = (patch: Partial<AgentInfo>): StreamFrame => ({
  type: "agent",
  agent: makeAgent(patch),
});

let server: FakeServer;
let fakeDocument: FakeDocument;
let fakeWindow: FakeWindow;
let queryClient: QueryClient;
let deps: Partial<RegistryDeps> & {
  fetchSnapshot: ReturnType<typeof vi.fn<(id: AgentId) => Promise<Snapshot>>>;
  ack: ReturnType<typeof vi.fn>;
};
let registry: LiveRegistry;

function start(): LiveRegistry {
  registry = new LiveRegistry(queryClient, deps);
  registry.start();
  return registry;
}

/** Opens `id`, lets its snapshot land and serves the stream that follows. */
async function openHydrated(id: AgentId): Promise<ConversationStore> {
  const store = registry.open(id);
  await flush();
  server.connect(latest());
  return store;
}

/** A snapshot that resolves, with the server's state at that time, when `release` is called. */
function deferSnapshot(): { release: () => void } {
  const control = { release: () => {} };
  deps.fetchSnapshot.mockImplementationOnce(
    (id) =>
      new Promise<Snapshot>((resolve) => {
        control.release = () => resolve(server.snapshot(id));
      }),
  );
  return control;
}

beforeEach(() => {
  server = new FakeServer();
  server.add("a1");
  server.add("a2");
  fakeDocument = new FakeDocument();
  fakeWindow = new FakeWindow();
  queryClient = new QueryClient();
  deps = {
    fetchSnapshot: vi.fn(async (id: AgentId) => server.snapshot(id)),
    ack: vi.fn(async () => {}),
    document: fakeDocument as unknown as RegistryDeps["document"],
    window: fakeWindow as unknown as RegistryDeps["window"],
  };
});

afterEach(() => {
  registry.stop();
  vi.useRealTimers();
});

describe("LiveRegistry", () => {
  it("streams agents, sessions and branches with nothing opened", () => {
    start();
    expect(new URL(latest().url).pathname).toBe("/api/stream");
    expect(new URL(latest().url).search).toBe("");
    expect(registry.live.getState()).toMatchObject({ loaded: false, connection: "connecting" });
    latest().open();
    latest().send(agentFrame({ id: "a1" }));
    expect(registry.live.getState().connection).toBe("connecting");
    latest().send({
      type: "baseline",
      agents: [makeAgent({ id: "a1" })],
      sessions: [session("s1")],
      branches: { "/home/me/project": "main" },
    });
    expect(registry.live.getState()).toMatchObject({
      loaded: true,
      agents: { a1: { id: "a1" } },
      sessions: [{ id: "s1" }],
      branches: { "/home/me/project": "main" },
      connection: "live",
    });

    latest().send(agentFrame({ id: "a2", isStreaming: true }));
    latest().send({ type: "branch", cwd: "/home/me/other", branch: "feat" });
    latest().send({ type: "branch", cwd: "/home/me/project", branch: null });
    latest().send({ type: "agent_closed", agentId: "a1" });
    expect(Object.keys(registry.live.getState().agents)).toEqual(["a2"]);
    expect(registry.live.getState().branches).toEqual({ "/home/me/other": "feat" });
  });

  it("invalidates the session and project lists only when what they show or their order changes", () => {
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const invalidated = () => invalidateQueries.mock.calls.map(([filters]) => filters?.queryKey);
    start();
    latest().open();
    latest().send({ type: "baseline", agents: [], sessions: [session("s1")], branches: {} });

    // A session write only moves updatedAt: nothing to refetch.
    const touched = { ...session("s1"), updatedAt: "2026-01-03T00:00:00.000Z" };
    latest().send({ type: "catalog", sessions: [touched] });
    expect(registry.live.getState().sessions).toEqual([touched]);
    expect(invalidateQueries).not.toHaveBeenCalled();

    // A new session in a known folder.
    latest().send({ type: "catalog", sessions: [session("s2"), touched] });
    expect(invalidated()).toEqual([["sessions"], ["projects"]]);

    // A rename.
    invalidateQueries.mockClear();
    latest().send({ type: "catalog", sessions: [{ ...session("s2"), name: "Named" }, touched] });
    expect(invalidated()).toEqual([["sessions"], ["projects"]]);

    // A write to the second session moves it to the top.
    invalidateQueries.mockClear();
    const top = { ...touched, updatedAt: "2026-01-04T00:00:00.000Z" };
    latest().send({ type: "catalog", sessions: [top, { ...session("s2"), name: "Named" }] });
    expect(invalidated()).toEqual([["sessions"], ["projects"]]);

    // Another write to it keeps the order.
    invalidateQueries.mockClear();
    const retouched = { ...touched, updatedAt: "2026-01-05T00:00:00.000Z" };
    latest().send({ type: "catalog", sessions: [retouched, { ...session("s2"), name: "Named" }] });
    expect(invalidateQueries).not.toHaveBeenCalled();

    // A new folder.
    invalidateQueries.mockClear();
    const elsewhere = { ...session("s3"), cwd: "/home/me/other" };
    latest().send({
      type: "catalog",
      sessions: [elsewhere, retouched, { ...session("s2"), name: "Named" }],
    });
    expect(invalidated()).toEqual([["sessions"], ["projects"]]);
  });

  it("reconnects on each hydrate with every hydrated store at its seq", async () => {
    const events = fixtureEvents("plain-answer");
    for (const event of events.slice(0, 5)) server.push("a1", event);
    for (const event of events.slice(0, 3)) server.push("a2", event);
    start();
    server.connect(latest());

    const a1 = registry.open("a1");
    expect(a1.getState().connection).toBe("connecting");
    await flush();
    expect(a1.getState()).toMatchObject({ hydrated: true, seq: 5 });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latest().cursors).toBe("a1:5");
    server.connect(latest());
    for (const event of events.slice(5, 8)) server.push("a1", event);
    expect(a1.getState().seq).toBe(8);

    await openHydrated("a2");
    expect(FakeEventSource.instances).toHaveLength(3);
    expect(latest().cursors).toBe("a1:8,a2:3");
    // One EventSource at a time.
    expect(openStreams()).toEqual([latest()]);
    expect(a1.getState().connection).toBe("live");
  });

  it("switching between opened stores doesn't reconnect", async () => {
    start();
    const a1 = await openHydrated("a1");
    await openHydrated("a2");
    const count = FakeEventSource.instances.length;
    expect(registry.open("a1")).toBe(a1);
    registry.show("a2")();
    registry.show("a1");
    expect(FakeEventSource.instances).toHaveLength(count);
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("leaves no gaps or duplicates: one store resyncs while the other streams, across Last-Event-ID resumes", async () => {
    const events = fixtureEvents("plain-answer");
    const next = { a1: 0, a2: 0 };
    const push = (id: "a1" | "a2", count: number) => {
      for (let i = 0; i < count; i++) server.push(id, events[next[id]++] as ServerEvent);
    };
    push("a1", 5);
    push("a2", 3);
    start();
    server.connect(latest());
    const a1 = registry.open("a1");
    const a1Seqs = trackSeqs(a1);
    await flush();
    server.connect(latest());
    const a2 = registry.open("a2");
    const a2Seqs = trackSeqs(a2);
    await flush();
    server.connect(latest());
    push("a1", 10);
    push("a2", 10);

    // The connection drops; both logs grow meanwhile and a1's ring buffer moves past its cursor.
    const stream = latest();
    server.disconnect();
    expect(a1.getState().connection).toBe("reconnecting");
    push("a1", 10);
    push("a2", 10);
    server.trim("a1");
    push("a1", 5);

    // The browser reconnects with Last-Event-ID: a2 replays, a1 resyncs.
    const snapshot = deferSnapshot();
    server.connect(stream, stream.lastEventId);
    expect(deps.fetchSnapshot).toHaveBeenLastCalledWith("a1");
    expect(a1.getState().connection).toBe("connecting");
    expect(a2.getState()).toMatchObject({ seq: 23, connection: "live" });

    // a2 keeps streaming, and resumes again, while a1's snapshot is in flight; a1 ignores its
    // frames meanwhile.
    push("a1", 10);
    push("a2", 10);
    server.disconnect();
    push("a1", 5);
    push("a2", 5);
    server.connect(stream, stream.lastEventId);
    push("a1", 5);
    push("a2", 5);
    expect(a1.getState().seq).toBe(15);
    expect(a2.getState().seq).toBe(43);
    expect(FakeEventSource.instances.at(-1)).toBe(stream);

    // a1 hydrates, then the stream reconnects with both cursors.
    snapshot.release();
    await flush();
    expect(stream.closed).toBe(true);
    expect(latest().cursors).toBe("a1:50,a2:43");
    server.connect(latest());
    push("a1", events.length - next.a1);
    push("a2", events.length - next.a2);

    for (const [store, seqs] of [
      [a1, a1Seqs],
      [a2, a2Seqs],
    ] as const) {
      expect(gaps(seqs)).toEqual([]);
      expect(store.getState().seq).toBe(events.length);
      expect(store.getState().live).toEqual(reduceAll(events));
    }
  });

  it("leaves a refetching store out of reconnects until it's hydrated", async () => {
    start();
    const a1 = await openHydrated("a1");
    await openHydrated("a2");
    const snapshot = deferSnapshot();
    latest().send({ type: "resync", agentId: "a1" });
    expect(a1.getState().connection).toBe("connecting");

    // The browser gives up; back online, the stream reopens without a1.
    latest().fail();
    fakeWindow.dispatchEvent(new Event("online"));
    expect(latest().cursors).toBe("a2:0");
    server.connect(latest());
    // Its frames (and a second resync) are ignored meanwhile.
    latest().send({ type: "resync", agentId: "a1" });
    latest().send({
      type: "event",
      agentId: "a1",
      seq: 1,
      event: { type: "pi", event: { type: "agent_start" } },
    });
    expect(a1.getState().seq).toBe(0);
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(3);

    server.push("a1", { type: "pi", event: { type: "agent_start" } });
    snapshot.release();
    await flush();
    expect(latest().cursors).toBe("a1:1,a2:0");
    expect(a1.getState()).toMatchObject({ seq: 1, live: { run: { active: true } } });
  });

  it("invalidates the agent's review queries on each git_status event and each refetch's hydrate", async () => {
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const invalidated = () => invalidateQueries.mock.calls.map(([filters]) => filters?.queryKey);
    start();
    await openHydrated("a1");
    await openHydrated("a2");
    invalidateQueries.mockClear();

    const status = { branch: "main", dirty: true };
    server.push("a1", { type: "git_status", status });
    // An unchanged status is a refresh signal too.
    server.push("a1", { type: "git_status", status });
    server.push("a2", { type: "pi", event: { type: "agent_start" } });
    expect(invalidated()).toEqual([
      ["agent", "a1", "review"],
      ["agent", "a1", "review"],
    ]);

    // A resync drops the events until the snapshot lands; the hydrate invalidates.
    invalidateQueries.mockClear();
    const snapshot = deferSnapshot();
    latest().send({ type: "resync", agentId: "a2" });
    expect(invalidateQueries).not.toHaveBeenCalled();
    snapshot.release();
    await flush();
    expect(invalidated()).toEqual([["agent", "a2", "review"]]);
  });

  it("refetches a store when its agent becomes ready", async () => {
    deps.fetchSnapshot
      .mockResolvedValueOnce(makeSnapshot({ seq: 1, agent: makeAgent({ status: "starting" }) }))
      .mockResolvedValueOnce(makeSnapshot({ seq: 3, agent: makeAgent({ status: "ready" }) }));
    start();
    const a1 = registry.open("a1");
    await flush();
    expect(latest().cursors).toBe("a1:1");
    const agent = makeAgent({ status: "ready" });
    latest().send({ type: "event", agentId: "a1", seq: 2, event: { type: "agent_status", agent } });
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(2);
    await flush();
    expect(a1.getState().seq).toBe(3);
    expect(latest().cursors).toBe("a1:3");
  });

  it("drops stores whose agent is missing from a new baseline, or closed", async () => {
    start();
    const a1 = await openHydrated("a1");
    const a2 = await openHydrated("a2");
    server.add("a3");
    // a3's snapshot is in flight: this stream may predate it, so its absence proves nothing.
    const snapshot = deferSnapshot();
    const a3 = registry.open("a3");

    latest().send({
      type: "baseline",
      agents: [makeAgent({ id: "a2" })],
      sessions: [],
      branches: {},
    });
    expect(a1.getState().closed).toBe(true);
    expect(a2.getState().closed).toBe(false);
    expect(a3.getState().closed).toBe(false);
    expect(registry.open("a1")).not.toBe(a1);

    latest().send({ type: "agent_closed", agentId: "a2" });
    expect(a2.getState().closed).toBe(true);
    // Late frames for a dropped store go nowhere.
    latest().send({
      type: "event",
      agentId: "a2",
      seq: 1,
      event: { type: "pi", event: { type: "agent_start" } },
    });
    expect(a2.getState().seq).toBe(0);
    snapshot.release();
  });

  it("marks a store closed when its agent doesn't exist", async () => {
    deps.fetchSnapshot.mockRejectedValueOnce(new ApiRequestError(404, "agent_not_found", "no"));
    start();
    const store = registry.open("gone");
    await flush();
    expect(store.getState().closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("retries a failed snapshot with backoff", async () => {
    vi.useFakeTimers();
    deps.fetchSnapshot
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("network"));
    start();
    const a1 = registry.open("a1");
    await flush();
    expect(a1.getState().connection).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(999);
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(3);
    expect(a1.getState().hydrated).toBe(true);
    expect(latest().cursors).toBe("a1:0");
  });

  it("lets EventSource retry transient errors, and reconnects with backoff after it gives up", async () => {
    vi.useFakeTimers();
    start();
    const a1 = await openHydrated("a1");
    expect(a1.getState().connection).toBe("live");

    latest().drop();
    expect(a1.getState().connection).toBe("reconnecting");
    expect(registry.live.getState().connection).toBe("reconnecting");
    server.connect(latest(), latest().lastEventId);
    expect(a1.getState().connection).toBe("live");
    const count = FakeEventSource.instances.length;

    latest().fail();
    expect(a1.getState().connection).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeEventSource.instances).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(count + 1);
    expect(latest().cursors).toBe("a1:0");
    latest().fail();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeEventSource.instances).toHaveLength(count + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(count + 2);
    // A successful open resets the backoff.
    server.connect(latest());
    latest().fail();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeEventSource.instances).toHaveLength(count + 3);
    expect(deps.fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("on visible, reopens a closed stream or one silent for 35 s", async () => {
    vi.useFakeTimers();
    start();
    server.connect(latest());

    // Pings keep a quiet stream alive.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      latest().ping();
    }
    fakeDocument.setVisibility("visible");
    expect(FakeEventSource.instances).toHaveLength(1);

    // So do frames.
    await vi.advanceTimersByTimeAsync(30_000);
    latest().send(agentFrame({ id: "a1" }));
    await vi.advanceTimersByTimeAsync(30_000);
    fakeDocument.setVisibility("visible");
    expect(FakeEventSource.instances).toHaveLength(1);

    // The tab was suspended: the stream looks open but nothing arrived for too long.
    fakeDocument.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(STALE_AFTER_MS + 1);
    const stale = latest();
    fakeDocument.setVisibility("visible");
    expect(stale.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);

    // Closed while hidden: reopened right away, not after the backoff.
    latest().fail();
    fakeDocument.setVisibility("visible");
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("goes offline with the browser and reopens when back online", async () => {
    start();
    const a1 = await openHydrated("a1");
    fakeWindow.navigator.onLine = false;
    fakeWindow.dispatchEvent(new Event("offline"));
    expect(a1.getState().connection).toBe("offline");
    expect(registry.live.getState().connection).toBe("offline");
    latest().fail();
    const count = FakeEventSource.instances.length;
    fakeWindow.navigator.onLine = true;
    fakeWindow.dispatchEvent(new Event("online"));
    expect(FakeEventSource.instances).toHaveLength(count + 1);
    server.connect(latest());
    expect(a1.getState().connection).toBe("live");
  });

  it("acks the conversation on screen when shown, on visible, and on attention while focused", async () => {
    start();
    server.connect(latest());
    const hide = registry.show("a1");
    expect(deps.ack).toHaveBeenCalledTimes(1);
    expect(deps.ack).toHaveBeenLastCalledWith("a1");

    fakeDocument.setVisibility("hidden");
    fakeDocument.setVisibility("visible");
    expect(deps.ack).toHaveBeenCalledTimes(2);

    latest().send(agentFrame({ id: "a1", attention: "none" }));
    latest().send(agentFrame({ id: "a2", attention: "finished" }));
    expect(deps.ack).toHaveBeenCalledTimes(2);
    latest().send(agentFrame({ id: "a1", attention: "finished" }));
    expect(deps.ack).toHaveBeenCalledTimes(3);
    // Only a raise acks: the same attention again (a frame for another field) doesn't.
    latest().send(agentFrame({ id: "a1", attention: "finished", isStreaming: true }));
    expect(deps.ack).toHaveBeenCalledTimes(3);

    // Visible but another window has focus: not seen yet, until the window is focused.
    fakeDocument.focused = false;
    latest().send(agentFrame({ id: "a1", attention: "input" }));
    expect(deps.ack).toHaveBeenCalledTimes(3);
    fakeDocument.focused = true;
    fakeWindow.dispatchEvent(new Event("focus"));
    expect(deps.ack).toHaveBeenCalledTimes(4);
    fakeDocument.visibilityState = "hidden";
    latest().send(agentFrame({ id: "a1", attention: "failed" }));
    expect(deps.ack).toHaveBeenCalledTimes(4);

    // Off screen: no acks.
    hide();
    fakeDocument.setVisibility("visible");
    fakeWindow.dispatchEvent(new Event("focus"));
    latest().send(agentFrame({ id: "a1", attention: "finished" }));
    expect(deps.ack).toHaveBeenCalledTimes(4);
  });

  it("on focus, reopens a closed stream", () => {
    start();
    server.connect(latest());
    latest().fail();
    fakeWindow.dispatchEvent(new Event("focus"));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(openStreams()).toEqual([latest()]);
  });

  it("stop closes the stream and drops in-flight snapshots; start resumes", async () => {
    const snapshot = deferSnapshot();
    start();
    const a1 = registry.open("a1");
    server.connect(latest());
    registry.stop();
    expect(latest().closed).toBe(true);
    expect(registry.live.getState().connection).toBe("connecting");
    snapshot.release();
    await flush();
    expect(a1.getState().hydrated).toBe(false);
    fakeDocument.setVisibility("visible");
    expect(FakeEventSource.instances).toHaveLength(1);

    fakeWindow.dispatchEvent(new Event("focus"));
    expect(FakeEventSource.instances).toHaveLength(1);

    registry.start();
    await flush();
    expect(a1.getState().hydrated).toBe(true);
    expect(openStreams()).toEqual([latest()]);
    expect(latest().cursors).toBe("a1:0");
  });
});
