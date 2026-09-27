import { initialLiveState } from "@pi-code/protocol";
import { describe, expect, it } from "vitest";
import {
  applyAll,
  fixtureEvents,
  fixtureNames,
  initialCaches,
  makeAgent,
  makeSnapshot,
  reduceAll,
} from "@/test/fixtures";
import { createConversationStore } from "./conversation-store";
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
});
