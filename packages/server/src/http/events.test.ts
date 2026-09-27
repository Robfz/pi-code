import type { ServerEvent, SessionEntry, Snapshot } from "@pi-code/protocol";
import { afterEach, expect, describe as group, it } from "vitest";
import { fixturePath, loadFixture } from "../../../../test/fake-pi.ts";
import {
  describe,
  type Harness,
  type HarnessOptions,
  type Received,
  replay,
  startHarness,
  stateOf,
} from "../testing/http-harness.ts";

let harness: Harness | undefined;

async function start(opts: HarnessOptions = {}): Promise<Harness> {
  harness = await startHarness(opts);
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const isPi = (type: string) => (r: Received) =>
  r.event.type === "pi" && r.event.event.type === type;

function entryKinds(entries: readonly SessionEntry[]): string[] {
  return entries.map((e) => (e.type === "message" ? e.message.role : e.type));
}

/** pi session event types recorded in a fixture, in stdout order. */
function recordedEventTypes(fixture: string): string[] {
  return loadFixture(fixturePath(fixture))
    .filter((l) => l.dir === "out")
    .map((l) => (l.line as { type: string }).type)
    .filter(
      (t) => t !== "response" && t !== "extension_ui_request" && t !== "bash_execution_update",
    );
}

/** Prompts and waits until the run and its side effects are published. */
async function promptAndSettle(h: Harness, agentId: string, message = "hi"): Promise<void> {
  const res = await h.rpc(agentId, { type: "prompt", message });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const client = h.sse(agentId, { since: 0 });
  await client.waitFor(isPi("agent_settled"), 10_000);
  await client.close();
  await h.idle(agentId);
}

group("pipeline and snapshot", () => {
  it("commits the plain-answer entries into the snapshot transcript", async () => {
    const h = await start({ fixture: "plain-answer" });
    const agent = await h.open();
    const before = await h.snapshot(agent.id);
    expect(before.agent.status).toBe("ready");
    expect(before.state?.sessionId).toBeTypeOf("string");
    expect(before.stats).not.toBeNull();

    await promptAndSettle(h, agent.id);
    expect(h.manager.require(agent.id).info().attention).toBe("finished");

    const snap = await h.snapshot(agent.id);
    expect(entryKinds(snap.transcript.entries)).toEqual([
      "model_change",
      "thinking_level_change",
      "system",
      "user",
      "assistant",
    ]);
    expect(snap.transcript.leafId).toBe(snap.transcript.entries.at(-1)?.id);
    expect(snap.live.streaming).toBeUndefined();
    expect(snap.live.pendingUser).toBeUndefined();
    expect(snap.live.run.active).toBe(false);
    expect(snap.live.statuses.mcp).toContain("MCP");
    // Fetching the snapshot cleared the attention (and published it).
    expect(snap.agent.attention).toBe("none");
    expect(snap.agent.isStreaming).toBe(false);
    expect(snap.gitStatus).toBeNull();
    expect(snap.seq).toBe(h.manager.require(agent.id).pipeline.seq);
  });

  it("keeps events strictly ordered when get_entries is slow", async () => {
    const h = await start({ fixture: "plain-answer", delayGetEntriesMs: 60 });
    const agent = await h.open();
    const client = h.sse(agent.id, { since: 0 });
    const t0 = Date.now();
    expect((await h.rpc(agent.id, { type: "prompt", message: "hi" })).status).toBe(200);
    await client.waitFor(isPi("agent_settled"), 10_000);
    await h.idle(agent.id);
    const seq = h.manager.require(agent.id).pipeline.seq;
    await client.waitForSeq(seq);
    // Several syncs, each 60 ms late, ran in sequence.
    expect(Date.now() - t0).toBeGreaterThan(4 * 60);

    const events = client.events;
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

    // pi events come out exactly in stdout order.
    const piTypes = events.flatMap((r) => (r.event.type === "pi" ? [r.event.event.type] : []));
    expect(piTypes).toEqual(recordedEventTypes("plain-answer"));

    // Derived events follow their trigger immediately.
    const labels = events.map(describe);
    const assistantEnd = events.findIndex(
      (r) =>
        r.event.type === "pi" &&
        r.event.event.type === "message_end" &&
        r.event.event.message.role === "assistant",
    );
    const next = events[assistantEnd + 1]?.event;
    expect(next?.type).toBe("entries_appended");
    expect(
      entryKinds((next as Extract<ServerEvent, { type: "entries_appended" }>).entries),
    ).toEqual(["assistant"]);
    expect(labels[labels.indexOf("pi:turn_end") + 1]).toBe("stats");
    // Entries are never committed ahead of their message events.
    const userAppended = events.findIndex(
      (r) => r.event.type === "entries_appended" && entryKinds(r.event.entries).includes("user"),
    );
    const userEnd = events.findIndex(
      (r) =>
        r.event.type === "pi" &&
        r.event.event.type === "message_end" &&
        r.event.event.message.role === "user",
    );
    expect(userAppended).toBe(userEnd + 1);
    // The fixture's setStatus request precedes agent_start, as on stdout.
    expect(labels.indexOf("ui_request")).toBeLessThan(labels.indexOf("pi:agent_start"));
    // Finished → attention.
    expect(events.at(-1)?.event).toMatchObject({
      type: "agent_status",
      agent: { attention: "finished" },
    });

    const snap = await h.snapshot(agent.id);
    expect(snap.live.streaming).toBeUndefined();
    expect(entryKinds(snap.transcript.entries)).toContain("assistant");
  });

  it("snapshot at any point + replay from its seq equals the final state", async () => {
    const h = await start({ fixture: "tool-calls", speed: 4 });
    const agent = await h.open();
    const snapshots: Promise<Snapshot>[] = [h.snapshot(agent.id)];
    const watcher = h.sse(agent.id, { since: 0 });
    let count = 0;
    const settled = watcher.until(() => {
      // Take a snapshot every few events while the run streams.
      while (count < watcher.events.length) {
        count += 1;
        if (count % 4 === 0) snapshots.push(h.snapshot(agent.id));
      }
      return watcher.events.find(isPi("agent_settled"));
    }, 10_000);
    expect((await h.rpc(agent.id, { type: "prompt", message: "go" })).status).toBe(200);
    await settled;
    await h.idle(agent.id);
    const taken = await Promise.all(snapshots);
    const final = await h.snapshot(agent.id);
    expect(final.live.tools).toEqual({});
    expect(entryKinds(final.transcript.entries)).toContain("toolResult");
    expect(taken.length).toBeGreaterThan(5);
    expect(new Set(taken.map((s) => s.seq)).size).toBeGreaterThan(3);

    for (const snap of taken) {
      const client = h.sse(agent.id, { since: snap.seq });
      if (snap.seq < final.seq) await client.waitForSeq(final.seq);
      const events = client.events
        .filter((r) => r.seq !== undefined && r.seq <= final.seq)
        .map((r) => r.event);
      expect(events.length, `from ${snap.seq}`).toBe(final.seq - snap.seq);
      expect(replay(snap, events), `from ${snap.seq}`).toEqual(stateOf(final));
      await client.close();
    }
  });
});

group("SSE", () => {
  it("resumes after a disconnect with the same events as an uninterrupted client", async () => {
    const h = await start({ fixture: "tool-calls", speed: 4 });
    const agent = await h.open();
    const steady = h.sse(agent.id, { since: 0 });
    const first = h.sse(agent.id, { since: 0 });
    expect((await h.rpc(agent.id, { type: "prompt", message: "go" })).status).toBe(200);
    await first.until(() => (first.events.length >= 12 ? true : undefined));
    await first.close();
    const lastSeq = first.lastSeq as number;
    expect(first.events.length).toBeGreaterThanOrEqual(12);

    await new Promise((r) => setTimeout(r, 150));
    const second = h.sse(agent.id, { lastEventId: lastSeq, since: 1 }); // header wins
    await steady.waitFor(isPi("agent_settled"), 10_000);
    await h.idle(agent.id);
    const seq = h.manager.require(agent.id).pipeline.seq;
    await steady.waitForSeq(seq);
    await second.waitForSeq(seq);

    const resumed = [...first.events, ...second.events];
    expect(resumed.map((r) => r.seq)).toEqual(steady.events.map((r) => r.seq));
    expect(resumed).toEqual(steady.events);
    expect(second.events[0]?.seq).toBe(lastSeq + 1);
  });

  it("sends resync when the resume point is out of range", async () => {
    const h = await start({ fixture: "plain-answer", eventLogCapacity: 5 });
    const agent = await h.open();
    await promptAndSettle(h, agent.id);
    const seq = h.manager.require(agent.id).pipeline.seq;
    expect(seq).toBeGreaterThan(10);

    for (const since of [seq + 1, 1, "abc", -1]) {
      const client = h.sse(agent.id, { since });
      const first = await client.waitFor(() => true);
      expect(first, String(since)).toEqual({ event: { type: "resync" } });
      await client.close();
    }
    // Still in the ring: plain replay.
    const inRange = h.sse(agent.id, { since: seq - 3 });
    await inRange.waitForSeq(seq);
    expect(inRange.events.map((r) => r.seq)).toEqual([seq - 2, seq - 1, seq]);
    // Up to date: nothing to replay, then live events.
    const current = h.sse(agent.id, { lastEventId: seq });
    await h.api("POST", `/api/agents/${agent.id}/ack`, {}); // finished → none
    await h.snapshot(agent.id); // already none: no event
    expect((await h.rpc(agent.id, { type: "get_state" })).status).toBe(200); // query: no event
    await current.waitForSeq(seq + 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(current.events.map(describe)).toEqual(["agent_status"]);
    expect(current.events[0]?.seq).toBe(seq + 1);
    expect(current.status).toBe(200);
  });

  it("streams only new events without a resume point, pings, and cleans up on disconnect", async () => {
    const h = await start({ fixture: "plain-answer", ssePingMs: 40 });
    const agent = await h.open();
    const log = h.manager.require(agent.id).pipeline.log;
    const client = h.sse(agent.id);
    await client.until(() => (client.comments.includes("ping") ? true : undefined));
    expect(client.retry).toBe(2000);
    expect(client.events).toEqual([]);
    expect(log.subscriberCount).toBe(1);

    const seq = log.seq;
    expect((await h.rpc(agent.id, { type: "prompt", message: "hi" })).status).toBe(200);
    await client.waitFor(isPi("agent_settled"));
    expect(client.events[0]?.seq).toBe(seq + 1);

    await client.close();
    const deadline = Date.now() + 2_000;
    while (log.subscriberCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(log.subscriberCount).toBe(0);
  });

  it("ends streams with the final status when the agent is closed", async () => {
    const h = await start();
    const agent = await h.open();
    const client = h.sse(agent.id, { since: 0 });
    await client.waitFor(
      (r) => r.event.type === "agent_status" && r.event.agent.status === "ready",
    );
    expect((await h.api("DELETE", `/api/agents/${agent.id}`, {})).status).toBe(204);
    await client.done;
    expect(client.events.at(-1)?.event).toMatchObject({
      type: "agent_status",
      agent: { status: "exited" },
    });
  });

  it("returns 404 for unknown agents", async () => {
    const h = await start();
    const res = await h.api("GET", "/api/agents/nope/events");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("agent_not_found");
    expect((await h.api("GET", "/api/agents/nope/snapshot")).status).toBe(404);
  });
});

group("attention", () => {
  it("is set when a run finishes and cleared by ack", async () => {
    const h = await start({ fixture: "plain-answer" });
    const agent = await h.open();
    const client = h.sse(agent.id, { since: 0 });
    await promptAndSettle(h, agent.id);
    const listed = await h.json<{ agents: { attention: string }[] }>("GET", "/api/agents");
    expect(listed.body.agents[0]?.attention).toBe("finished");

    const res = await h.api("POST", `/api/agents/${agent.id}/ack`, {});
    expect(res.status).toBe(204);
    const status = await client.waitFor(
      (r) =>
        r.event.type === "agent_status" && r.event.agent.attention === "none" && (r.seq ?? 0) > 3,
    );
    expect(status.event).toMatchObject({ agent: { status: "ready", attention: "none" } });
    expect(h.manager.require(agent.id).info().attention).toBe("none");
  });

  it("stays none after a user abort", async () => {
    const h = await start({ fixture: "abort" });
    const agent = await h.open();
    const client = h.sse(agent.id, { since: 0 });
    expect((await h.rpc(agent.id, { type: "prompt", message: "story" })).status).toBe(200);
    // The abort response arrives after agent_settled.
    const abort = await h.rpc(agent.id, { type: "abort" });
    expect(abort.status).toBe(200);
    await client.waitFor(isPi("agent_settled"));
    await h.idle(agent.id);
    expect(h.manager.require(agent.id).info().attention).toBe("none");
    const snap = await h.snapshot(agent.id);
    expect(snap.live.run).toEqual({ active: false });
    expect(entryKinds(snap.transcript.entries).at(-1)).toBe("assistant");
  });
});
