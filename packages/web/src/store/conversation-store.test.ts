import { initialLiveState, type LiveState } from "@pi-code/protocol";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  applyAll,
  fixtureEvents,
  fixtureNames,
  initialCaches,
  makeAgent,
  makeSnapshot,
  reduceAll,
} from "@/test/fixtures";
import { type ConversationStore, createConversationStore, waitForSeq } from "./conversation-store";
import { selectActiveBranch, selectIsRunning, selectLabels, selectToolResults } from "./selectors";

const names = fixtureNames();

function hydratedEmpty() {
  const store = createConversationStore("a1");
  store.getState().hydrate(makeSnapshot({ agent: makeAgent() }));
  return store;
}

describe.each(names)("fixture %s through the store", (name) => {
  const events = fixtureEvents(name);

  it("matches the reducers' output", () => {
    const store = hydratedEmpty();
    events.forEach((event, index) => {
      store.getState().apply(event, index + 1);
    });
    const state = store.getState();
    const caches = applyAll(events, initialCaches(makeAgent()));
    expect(state.live).toEqual(reduceAll(events));
    expect(state.transcript).toEqual(caches.transcript);
    expect(state.state).toEqual(caches.state);
    expect(state.stats).toEqual(caches.stats);
    expect(state.agent).toEqual(caches.agent);
    expect(state.seq).toBe(events.length);
  });

  it.each([1, 7, Number.POSITIVE_INFINITY])(
    "applied in batches of %d, ends as applied one by one",
    (size) => {
      const sequential = hydratedEmpty();
      events.forEach((event, index) => {
        sequential.getState().apply(event, index + 1);
      });
      const batched = hydratedEmpty();
      const sequenced = events.map((event, index) => ({ event, seq: index + 1 }));
      for (let start = 0; start < sequenced.length; start += size) {
        batched.getState().applyBatch(sequenced.slice(start, start + size));
      }
      const { live, agent, state, transcript, stats, gitStatus, seq } = sequential.getState();
      expect(batched.getState()).toMatchObject({
        live,
        agent,
        state,
        transcript,
        stats,
        gitStatus,
        seq,
      });
    },
  );

  it("ignores replayed events (seq at or below the current one)", () => {
    const store = hydratedEmpty();
    events.forEach((event, index) => {
      store.getState().apply(event, index + 1);
    });
    const before = store.getState();
    events.forEach((event, index) => {
      store.getState().apply(event, index + 1);
    });
    expect(store.getState().live).toBe(before.live);
    expect(store.getState().transcript).toBe(before.transcript);
  });

  it("hydrating a mid-run snapshot and applying the rest equals the full run", () => {
    const cut = Math.floor(events.length / 2);
    const head = events.slice(0, cut);
    const caches = applyAll(head, initialCaches(makeAgent()));
    const store = createConversationStore("a1");
    store.getState().hydrate(
      makeSnapshot({
        agent: caches.agent,
        state: caches.state,
        transcript: caches.transcript,
        stats: caches.stats,
        live: reduceAll(head),
        seq: cut,
      }),
    );
    events.forEach((event, index) => {
      store.getState().apply(event, index + 1); // head is ignored as a replay
    });
    expect(store.getState().live).toEqual(reduceAll(events));
    expect(store.getState().transcript).toEqual(applyAll(events).transcript);
  });
});

describe("conversation store", () => {
  it("keeps untouched slices identical so selectors don't re-render", () => {
    const store = hydratedEmpty();
    const events = fixtureEvents("plain-answer");
    let seq = 0;
    for (const event of events) {
      const before = store.getState();
      store.getState().apply(event, ++seq);
      const after = store.getState();
      if (event.type === "pi" && event.event.type === "message_update") {
        expect(after.transcript).toBe(before.transcript);
        expect(after.live.queue).toBe(before.live.queue);
        expect(selectActiveBranch(after)).toBe(selectActiveBranch(before));
      }
    }
  });

  it("applies a batch with one update, and none for replays only", () => {
    const store = hydratedEmpty();
    const deltas = fixtureEvents("plain-answer")
      .filter((event) => event.type === "pi" && event.event.type === "message_update")
      .map((event, index) => ({ event, seq: index + 1 }));
    expect(deltas.length).toBeGreaterThan(5);
    let updates = 0;
    store.subscribe(() => updates++);
    const before = store.getState();
    store.getState().applyBatch(deltas);
    expect(updates).toBe(1);
    expect(store.getState().seq).toBe(deltas.length);
    expect(store.getState().transcript).toBe(before.transcript);
    store.getState().applyBatch(deltas);
    expect(updates).toBe(1);
  });

  it("shows each event of a batch to the visitor, replays included, and stops where it says", () => {
    const store = hydratedEmpty();
    const start = { type: "pi", event: { type: "agent_start" } } as const;
    const settled = { type: "pi", event: { type: "agent_settled" } } as never;
    store.getState().apply(start, 1);
    const seen: string[] = [];
    store.getState().applyBatch(
      [
        { event: start, seq: 1 },
        { event: settled, seq: 2 },
        { event: start, seq: 3 },
        { event: settled, seq: 4 },
      ],
      (_event, before, after) => {
        seen.push(`${before.seq}→${after.seq}:${after.live.run.active}`);
        return after.seq === 3;
      },
    );
    expect(seen).toEqual(["1→1:true", "1→2:false", "2→3:true"]);
    expect(store.getState().seq).toBe(3);
    expect(selectIsRunning(store.getState())).toBe(true);
  });

  it("derives the active branch, labels and tool results", () => {
    const store = hydratedEmpty();
    fixtureEvents("entry-types").forEach((event, index) => {
      store.getState().apply(event, index + 1);
    });
    const branch = selectActiveBranch(store.getState());
    const transcript = store.getState().transcript;
    expect(branch.at(-1)?.id).toBe(transcript.leafId);
    expect(selectLabels(store.getState())).toBeInstanceOf(Map);

    const tools = createConversationStore("a1");
    tools.getState().hydrate(makeSnapshot());
    fixtureEvents("tool-calls").forEach((event, index) => {
      tools.getState().apply(event, index + 1);
    });
    expect(selectToolResults(tools.getState()).size).toBe(2);
  });

  it("reports running from live state or pi's isStreaming", () => {
    const store = hydratedEmpty();
    expect(selectIsRunning(store.getState())).toBe(false);
    store.getState().apply({ type: "pi", event: { type: "agent_start" } }, 1);
    expect(selectIsRunning(store.getState())).toBe(true);
    store.getState().apply({ type: "pi", event: { type: "agent_settled" } } as never, 2);
    expect(selectIsRunning(store.getState())).toBe(false);
  });

  it("hydrate replaces everything and marks the store hydrated", () => {
    const store = createConversationStore("a1");
    expect(store.getState().hydrated).toBe(false);
    expect(store.getState().agent.id).toBe("a1");
    store.getState().hydrate(makeSnapshot({ seq: 42, agent: makeAgent({ cwd: "/x" }) }));
    expect(store.getState()).toMatchObject({ hydrated: true, seq: 42, agent: { cwd: "/x" } });
    expect(store.getState().live).toEqual(initialLiveState());
  });

  it("hydrate fills live fields an older server's snapshot lacks", () => {
    const store = createConversationStore("a1");
    const { thinkingMs: _, ...old } = initialLiveState();
    store.getState().hydrate(makeSnapshot({ live: old as LiveState }));
    expect(store.getState().live.thinkingMs).toEqual({});
    store.getState().apply({ type: "pi", event: { type: "agent_start" } }, 1);
    expect(store.getState().live.run.active).toBe(true);
  });
});

describe("waitForSeq", () => {
  const start = { type: "pi", event: { type: "agent_start" } } as const;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** `waitForSeq` with a flag that flips once it resolves. */
  function track(store: ConversationStore, seq: number) {
    const wait = { resolved: false };
    void waitForSeq(store, seq, 1000).then(() => {
      wait.resolved = true;
    });
    return wait;
  }

  /** Spies on the listener `waitForSeq` subscribes to `store`. */
  function spyListener(store: ConversationStore) {
    const subscribe = store.subscribe;
    type Listener = Parameters<ConversationStore["subscribe"]>[0];
    const spy: { listener?: Mock<Listener> } = {};
    vi.spyOn(store, "subscribe").mockImplementation((listener) => {
      const wrapped = vi.fn(listener);
      spy.listener = wrapped;
      return subscribe(wrapped);
    });
    return spy;
  }

  it("resolves at once, without a timer, when the store is already there", async () => {
    const store = createConversationStore("a1");
    store.getState().apply(start, 3);
    const wait = track(store, 3);
    expect(vi.getTimerCount()).toBe(0);
    await Promise.resolve();
    expect(wait.resolved).toBe(true);
  });

  it("resolves once the store reaches seq, and clears its timer", async () => {
    const store = createConversationStore("a1");
    const wait = track(store, 2);
    expect(vi.getTimerCount()).toBe(1);
    store.getState().apply(start, 1);
    await Promise.resolve();
    expect(wait.resolved).toBe(false);
    store.getState().apply(start, 2);
    await Promise.resolve();
    expect(wait.resolved).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves after the timeout, and stops listening to the store", async () => {
    const store = createConversationStore("a1");
    const spy = spyListener(store);
    const wait = track(store, 5);
    store.getState().apply(start, 1);
    expect(spy.listener).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(wait.resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(wait.resolved).toBe(true);
    store.getState().apply(start, 2);
    store.getState().apply(start, 5);
    expect(spy.listener).toHaveBeenCalledTimes(1);
  });
});
