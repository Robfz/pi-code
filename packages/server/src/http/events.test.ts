import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentInfo,
  SequencedEvent,
  ServerEvent,
  SessionEntry,
  Snapshot,
  StreamFrame,
} from "@pi-code/protocol";
import { afterEach, expect, describe as group, it } from "vitest";
import { fixturePath, loadFixture } from "../../../../test/fake-pi.ts";
import {
  describe,
  type Harness,
  type HarnessOptions,
  promptAndSettle,
  replay,
  type StreamClient,
  seqOf,
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

const isPi = (type: string) => (r: SequencedEvent) =>
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
    // Fetching the snapshot has no side effects: attention stays until acked.
    expect(snap.agent.attention).toBe("finished");
    expect(snap.agent.isStreaming).toBe(false);
    expect(snap.gitStatus).toBeNull();
    expect(snap.seq).toBe(seqOf(h, agent.id));
  });

  it("keeps events strictly ordered when get_entries is slow", async () => {
    const h = await start({ fixture: "plain-answer", delayGetEntriesMs: 60 });
    const agent = await h.open();
    const client = h.stream({ open: [[agent.id, 0]] });
    const t0 = Date.now();
    expect((await h.rpc(agent.id, { type: "prompt", message: "hi" })).status).toBe(200);
    await client.waitForEvent(agent.id, isPi("agent_settled"), 10_000);
    await h.idle(agent.id);
    const seq = seqOf(h, agent.id);
    await client.waitForSeq(agent.id, seq);
    // Several syncs, each 60 ms late, ran in sequence.
    expect(Date.now() - t0).toBeGreaterThan(4 * 60);

    const events = client.events(agent.id);
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
    const watcher = h.stream({ open: [[agent.id, 0]] });
    let count = 0;
    const settled = watcher.until(() => {
      // Take a snapshot every few events while the run streams.
      const events = watcher.events(agent.id);
      while (count < events.length) {
        count += 1;
        if (count % 4 === 0) snapshots.push(h.snapshot(agent.id));
      }
      return events.find(isPi("agent_settled"));
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
      const client = h.stream({ open: [[agent.id, snap.seq]] });
      if (snap.seq < final.seq) await client.waitForSeq(agent.id, final.seq);
      const events = client
        .events(agent.id)
        .filter((r) => r.seq <= final.seq)
        .map((r) => r.event);
      expect(events.length, `from ${snap.seq}`).toBe(final.seq - snap.seq);
      expect(replay(snap, events), `from ${snap.seq}`).toEqual(stateOf(final));
      await client.close();
    }
  });

  it("returns 404 for the snapshot of an unknown agent", async () => {
    const h = await start();
    const res = await h.api("GET", "/api/agents/nope/snapshot");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("agent_not_found");
  });
});

group("attention", () => {
  it("is set when a run finishes, kept by snapshots and cleared by ack", async () => {
    const h = await start({ fixture: "plain-answer" });
    const agent = await h.open();
    const client = h.stream({ open: [[agent.id, 0]] });
    await promptAndSettle(h, agent.id);
    const listed = await h.json<{ agents: { attention: string }[] }>("GET", "/api/agents");
    expect(listed.body.agents[0]?.attention).toBe("finished");
    const seq = seqOf(h, agent.id);
    expect((await h.snapshot(agent.id)).agent.attention).toBe("finished");
    expect(h.manager.require(agent.id).info().attention).toBe("finished");
    expect(seqOf(h, agent.id)).toBe(seq);

    const res = await h.api("POST", `/api/agents/${agent.id}/ack`, {});
    expect(res.status).toBe(204);
    const status = await client.waitForEvent(
      agent.id,
      (r) => r.event.type === "agent_status" && r.event.agent.attention === "none" && r.seq > 3,
    );
    expect(status.event).toMatchObject({ agent: { status: "ready", attention: "none" } });
    expect(h.manager.require(agent.id).info().attention).toBe("none");
  });

  it("stays none after a user abort", async () => {
    const h = await start({ fixture: "abort" });
    const agent = await h.open();
    const client = h.stream({ open: [[agent.id, 0]] });
    expect((await h.rpc(agent.id, { type: "prompt", message: "story" })).status).toBe(200);
    // The abort response arrives after agent_settled.
    const abort = await h.rpc(agent.id, { type: "abort" });
    expect(abort.status).toBe(200);
    await client.waitForEvent(agent.id, isPi("agent_settled"));
    await h.idle(agent.id);
    expect(h.manager.require(agent.id).info().attention).toBe("none");
    const snap = await h.snapshot(agent.id);
    expect(snap.live.run).toEqual({ active: false });
    expect(entryKinds(snap.transcript.entries).at(-1)).toBe("assistant");
  });
});

const MINI_PI = fileURLToPath(new URL("../testing/mini-pi.ts", import.meta.url));

type Frame<T extends StreamFrame["type"]> = Extract<StreamFrame, { type: T }>;

const isFrame =
  <T extends StreamFrame["type"]>(type: T) =>
  (f: StreamFrame): f is Frame<T> =>
    f.type === type;

/** The `agent` frames of `agentId` received so far. */
function agentFrames(client: StreamClient, agentId: string): AgentInfo[] {
  return client.frames.flatMap(({ frame }) =>
    frame.type === "agent" && frame.agent.id === agentId ? [frame.agent] : [],
  );
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Prompts every agent at once and waits until the runs and their side effects are published. */
async function promptAll(h: Harness, agentIds: string[], message = "go"): Promise<void> {
  const client = h.stream({ open: agentIds.map((id) => [id, seqOf(h, id)] as const) });
  await client.waitFor(isFrame("baseline"));
  const responses = await Promise.all(agentIds.map((id) => h.rpc(id, { type: "prompt", message })));
  for (const res of responses) expect(res.status, JSON.stringify(res.body)).toBe(200);
  for (const id of agentIds) {
    await client.until(() => client.events(id).find(isPi("agent_settled")), 10_000);
    await h.idle(id);
  }
  await client.close();
}

/** Resolves once `client` holds every event of `agentIds` published so far. */
async function caughtUp(h: Harness, client: StreamClient, agentIds: string[]): Promise<void> {
  for (const id of agentIds) await client.waitForSeq(id, seqOf(h, id), 10_000);
}

group("live stream", () => {
  it("starts with the baseline and, without open, carries agent frames only", async () => {
    const h = await start({ fixture: "plain-answer" });
    const agent = await h.open();
    const client = h.stream();
    const baseline = await client.waitFor(isFrame("baseline"));
    expect(baseline).toEqual({
      type: "baseline",
      agents: [h.manager.require(agent.id).info()],
      sessions: [],
      branches: {},
      sidebar: { pinned: [], collapsed: [], mains: {} },
      prs: {},
    });
    expect(client.retry).toBe(2000);
    expect(client.frames[0]?.id).toBe("");

    await promptAndSettle(h, agent.id);
    await client.until(() => agentFrames(client, agent.id).find((a) => a.attention === "finished"));
    expect(new Set(client.frames.map((f) => f.frame.type))).toEqual(new Set(["baseline", "agent"]));
    expect(client.frames.every((f) => f.id === "")).toBe(true);
  });

  it("sends agent frames when isStreaming and the session name change", async () => {
    const h = await start({ fixture: "entry-types" });
    const agent = await h.open();
    const client = h.stream();
    await client.waitFor(isFrame("baseline"));
    await promptAndSettle(h, agent.id, "Say hi");
    await client.until(() => agentFrames(client, agent.id).find((a) => a.attention === "finished"));
    expect(
      agentFrames(client, agent.id).map(({ isStreaming, attention }) => ({
        isStreaming,
        attention,
      })),
    ).toEqual([
      { isStreaming: true, attention: "none" },
      { isStreaming: false, attention: "none" },
      { isStreaming: false, attention: "finished" },
    ]);

    const previous = agentFrames(client, agent.id);
    expect((await h.rpc(agent.id, { type: "set_session_name", name: "s0 entries" })).status).toBe(
      200,
    );
    const named = await client.until(() => agentFrames(client, agent.id)[previous.length]);
    expect(named).toEqual({ ...previous.at(-1), sessionName: "s0 entries" });
  });

  it("sends an agent frame when the session file and id change", async () => {
    const h = await start({ command: () => ({ bin: process.execPath, args: [MINI_PI] }) });
    const agent = await h.open();
    const first = h.manager.require(agent.id).info();
    const client = h.stream();
    await client.waitFor(isFrame("baseline"));
    expect((await h.rpc(agent.id, { type: "new_session" })).status).toBe(200);
    await h.idle(agent.id);
    const switched = await client.until(() => agentFrames(client, agent.id)[0]);
    expect(agentFrames(client, agent.id)).toEqual([h.manager.require(agent.id).info()]);
    expect(switched.sessionFile).not.toBe(first.sessionFile);
    expect(switched.sessionId).not.toBe(first.sessionId);
  });

  it("streams two opened agents with per-agent seqs and complete cursor ids", async () => {
    const h = await start({ fixture: "tool-calls", speed: 4 });
    const a = await h.open();
    const b = await h.open();
    const open = [
      [a.id, (await h.snapshot(a.id)).seq],
      [b.id, (await h.snapshot(b.id)).seq],
    ] as const;
    const client = h.stream({ open });
    await client.waitFor(isFrame("baseline"));
    await promptAll(h, [a.id, b.id]);
    await caughtUp(h, client, [a.id, b.id]);

    for (const [id, from] of open) {
      expect(client.events(id).map((e) => e.seq)).toEqual(range(from + 1, seqOf(h, id)));
    }

    // Every frame's id is the complete resume point after it.
    const cursors = new Map<string, number>(open);
    for (const { id, frame } of client.frames) {
      if (frame.type === "event") cursors.set(frame.agentId, frame.seq);
      expect(id).toBe(`${a.id}:${cursors.get(a.id)},${b.id}:${cursors.get(b.id)}`);
    }
  });

  it("replays from a mid-log cursor the same events as an uninterrupted client", async () => {
    const h = await start({ fixture: "tool-calls", speed: 4 });
    const agent = await h.open();
    const from = (await h.snapshot(agent.id)).seq;
    const steady = h.stream({ open: [[agent.id, from]] });
    await steady.waitFor(isFrame("baseline"));
    await promptAll(h, [agent.id]);
    await caughtUp(h, steady, [agent.id]);

    const mid = Math.floor((from + seqOf(h, agent.id)) / 2);
    const late = h.stream({ open: [[agent.id, mid]] });
    await caughtUp(h, late, [agent.id]);
    expect(late.frames[0]?.id).toBe(`${agent.id}:${mid}`);
    expect(late.events(agent.id)).toEqual(steady.events(agent.id).filter((e) => e.seq > mid));
    expect(late.events(agent.id)[0]?.seq).toBe(mid + 1);
  });

  it("sends agent_closed on DELETE and keeps streaming", async () => {
    const h = await start();
    const agent = await h.open();
    const log = h.manager.require(agent.id).pipeline.log;
    const client = h.stream({ open: [[agent.id, seqOf(h, agent.id)]] });
    await client.waitFor(isFrame("baseline"));
    expect((await h.api("DELETE", `/api/agents/${agent.id}`, {})).status).toBe(204);
    await client.waitFor(isFrame("agent_closed"));
    // The closed log dropped the connection's subscription.
    expect(log.subscriberCount).toBe(0);
    expect(client.frames.at(-1)?.frame).toEqual({ type: "agent_closed", agentId: agent.id });
    expect(client.events(agent.id).at(-1)?.event).toMatchObject({
      type: "agent_status",
      agent: { status: "exited" },
    });
    expect(agentFrames(client, agent.id).at(-1)?.status).toBe("exited");

    const next = await h.open();
    await client.until(() => agentFrames(client, next.id)[0]);
  });

  it("drops a closed agent's pair from later ids", async () => {
    const h = await start({ fixture: "plain-answer" });
    const a = await h.open();
    const b = await h.open();
    const open = [
      [a.id, seqOf(h, a.id)],
      [b.id, seqOf(h, b.id)],
    ] as const;
    const client = h.stream({ open });
    await client.waitFor(isFrame("baseline"));
    expect((await h.api("DELETE", `/api/agents/${a.id}`, {})).status).toBe(204);
    await client.waitFor(isFrame("agent_closed"));
    const closedAt = client.frames.findIndex((f) => f.frame.type === "agent_closed");
    await promptAll(h, [b.id]);
    await caughtUp(h, client, [b.id]);

    expect(client.frames.slice(closedAt + 1).some((f) => f.frame.type === "event")).toBe(true);
    const cursors = new Map<string, number>(open);
    client.frames.forEach(({ id, frame }, i) => {
      if (frame.type === "event") cursors.set(frame.agentId, frame.seq);
      if (i > closedAt) expect(id).toBe(`${b.id}:${cursors.get(b.id)}`);
    });
  });

  it("ignores garbage pairs and unknown agents in open", async () => {
    const h = await start({ fixture: "plain-answer" });
    const agent = await h.open();
    const seq = seqOf(h, agent.id);
    const client = h.stream({ open: `garbage,:5,nope:3,,${agent.id}:${seq},${agent.id}` });
    await client.waitFor(isFrame("baseline"));
    expect(client.frames[0]?.id).toBe(`${agent.id}:${seq}`);
    expect((await h.rpc(agent.id, { type: "prompt", message: "hi" })).status).toBe(200);
    await client.waitForSeq(agent.id, seq + 1);
    expect(client.frames.map((f) => f.frame.type).slice(0, 2)).toEqual(["baseline", "event"]);
    expect(client.frames[1]?.id).toBe(`${agent.id}:${seq + 1}`);
  });

  it("pings with a named event without an id, and unsubscribes on disconnect", async () => {
    const h = await start({ sse: { pingMs: 40 } });
    const agent = await h.open();
    const log = h.manager.require(agent.id).pipeline.log;
    const client = h.stream({ open: [[agent.id, seqOf(h, agent.id)]] });
    await client.until(() => client.named.find((e) => e.name === "ping"));
    expect(client.named[0]).toEqual({ name: "ping", data: "{}" });
    expect(client.frames.map((f) => f.frame.type)).toEqual(["baseline"]);
    expect(log.subscriberCount).toBe(1);

    await client.close();
    const deadline = Date.now() + 2_000;
    while (log.subscriberCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(log.subscriberCount).toBe(0);
  });
});

group("live stream feeds", () => {
  it("sends catalog when the session watcher sees a new session", async () => {
    const h = await start({ watchSessions: true });
    const client = h.stream();
    await client.waitFor(isFrame("baseline"));
    const dir = join(h.agentDir, "sessions", "--project--");
    mkdirSync(dir);
    const header = { type: "session", version: 3, id: "s1", timestamp: new Date().toISOString() };
    const write = () =>
      writeFileSync(join(dir, "s1.jsonl"), `${JSON.stringify({ ...header, cwd: h.project })}\n`);
    write();
    // Rewritten until seen: the watch may miss changes made while it is still starting.
    const rewrite = setInterval(write, 200);
    const sessions = [
      {
        file: join(dir, "s1.jsonl"),
        id: "s1",
        cwd: h.project,
        createdAt: header.timestamp,
      },
    ];
    try {
      expect(await client.waitFor(isFrame("catalog"))).toEqual({ type: "catalog", sessions });
    } finally {
      clearInterval(rewrite);
    }
    expect(await h.stream().waitFor(isFrame("baseline"))).toMatchObject({ sessions });
  });

  it("tracks the branch of folders with a live agent, until none is left", async () => {
    const h = await start({ pipeline: { gitStatus: async () => null } });
    mkdirSync(join(h.project, ".git"));
    writeFileSync(join(h.project, ".git", "HEAD"), "ref: refs/heads/main\n");
    const client = h.stream();
    expect(await client.waitFor(isFrame("baseline"))).toMatchObject({ branches: {} });

    const a = await h.open();
    const b = await h.open();
    expect(await client.waitFor(isFrame("branch"))).toEqual({
      type: "branch",
      cwd: h.project,
      branch: "main",
    });
    const later = h.stream();
    expect(await later.waitFor(isFrame("baseline"))).toMatchObject({
      branches: { [h.project]: "main" },
    });

    // Rewritten until seen: the watch may miss changes made while it is still starting.
    const checkout = () =>
      writeFileSync(join(h.project, ".git", "HEAD"), "ref: refs/heads/feature\n");
    checkout();
    const rewrite = setInterval(checkout, 200);
    try {
      await client.waitFor((f) => f.type === "branch" && f.branch === "feature");
    } finally {
      clearInterval(rewrite);
    }

    // An exited agent isn't live: the folder is dropped once the other one is closed too.
    process.kill(h.manager.require(a.id).host.pid as number, "SIGKILL");
    await h.waitForStatus(a.id, "exited");
    expect((await h.api("DELETE", `/api/agents/${b.id}`, {})).status).toBe(204);
    await client.waitFor(isFrame("agent_closed"));
    const branchFrames = client.frames.flatMap(({ frame }) =>
      frame.type === "branch" ? [frame.branch] : [],
    );
    expect(branchFrames).toEqual(["main", "feature", null]);
    expect(h.hub.baseline().branches).toEqual({});
  });
});

group("live stream resume", () => {
  it("lets a Last-Event-ID cursor win per agent, streaming only the agents in open", async () => {
    const h = await start({ fixture: "plain-answer" });
    const a = await h.open();
    const b = await h.open();
    const c = await h.open();
    const seqA = seqOf(h, a.id);
    const client = h.stream({
      open: [
        [a.id, 0],
        [b.id, 0],
      ],
      lastEventId: `${a.id}:${seqA - 2},${c.id}:0`,
    });
    await caughtUp(h, client, [a.id, b.id]);
    expect(client.frames[0]?.id).toBe(`${a.id}:${seqA - 2},${b.id}:0`);
    expect(client.events(a.id).map((e) => e.seq)).toEqual([seqA - 1, seqA]);
    expect(client.events(b.id).map((e) => e.seq)).toEqual(range(1, seqOf(h, b.id)));
    expect(client.events(c.id)).toEqual([]);
  });

  it("writes the baseline and each replay before live frames queued during setup", async () => {
    const h = await start({ fixture: "plain-answer" });
    const a = await h.open();
    const b = await h.open();
    await promptAndSettle(h, a.id);
    await promptAndSettle(h, b.id);
    const seqA = seqOf(h, a.id);
    const seqB = seqOf(h, b.id);

    // Publishes a live event of `a` (and its agent frame) as the connection subscribes to the
    // hub, i.e. before anything is written.
    const subscribe = h.hub.subscribe.bind(h.hub);
    h.hub.subscribe = (listener) => {
      h.hub.subscribe = subscribe;
      const unsubscribe = subscribe(listener);
      h.manager.require(a.id).pipeline.setAttention("none");
      return unsubscribe;
    };
    const client = h.stream({
      open: [
        [a.id, seqA - 2],
        [b.id, seqB - 1],
      ],
    });
    await client.waitForSeq(a.id, seqA + 1);
    await client.until(() => agentFrames(client, a.id)[0]);
    const live = `${a.id}:${seqA + 1},${b.id}:${seqB}`;
    expect(client.frames.map(({ id, frame }) => [id, frame.type])).toEqual([
      [`${a.id}:${seqA - 2},${b.id}:${seqB - 1}`, "baseline"],
      [`${a.id}:${seqA - 1},${b.id}:${seqB - 1}`, "event"],
      [`${a.id}:${seqA},${b.id}:${seqB - 1}`, "event"],
      [`${a.id}:${seqA},${b.id}:${seqB}`, "event"],
      [live, "event"],
      [live, "agent"],
    ]);
    expect(
      client.frames.flatMap(({ frame }) =>
        frame.type === "event" ? [[frame.agentId, frame.seq]] : [],
      ),
    ).toEqual([
      [a.id, seqA - 1],
      [a.id, seqA],
      [b.id, seqB],
      [a.id, seqA + 1],
    ]);
  });

  it("resyncs one agent while another replays; a caught-up cursor replays nothing", async () => {
    const h = await start({ fixture: "plain-answer", eventLogCapacity: 5 });
    const a = await h.open();
    const b = await h.open();
    await promptAndSettle(h, a.id);
    const seqA = seqOf(h, a.id);
    const seqB = seqOf(h, b.id);
    expect(seqA).toBeGreaterThan(10);

    const client = h.stream({
      open: [
        [a.id, 1],
        [b.id, seqB - 2],
      ],
    });
    await caughtUp(h, client, [b.id]);
    expect(client.frames.map(({ id, frame }) => [id, frame.type])).toEqual([
      [`${b.id}:${seqB - 2}`, "baseline"],
      [`${a.id}:${seqA},${b.id}:${seqB - 2}`, "resync"],
      [`${a.id}:${seqA},${b.id}:${seqB - 1}`, "event"],
      [`${a.id}:${seqA},${b.id}:${seqB}`, "event"],
    ]);
    expect(client.frames[1]?.frame).toEqual({ type: "resync", agentId: a.id });

    const current = h.stream({ open: [[a.id, seqA]] });
    await current.waitFor(isFrame("baseline"));
    expect((await h.api("POST", `/api/agents/${a.id}/ack`, {})).status).toBe(204);
    await current.until(() => agentFrames(current, a.id)[0]);
    expect(current.frames.map(({ id, frame }) => [id, frame.type])).toEqual([
      [`${a.id}:${seqA}`, "baseline"],
      [`${a.id}:${seqA + 1}`, "event"],
      [`${a.id}:${seqA + 1}`, "agent"],
    ]);
  });

  it("resyncs an open cursor that isn't a seq or is ahead of the log", async () => {
    const h = await start({ fixture: "plain-answer" });
    const agent = await h.open();
    await promptAndSettle(h, agent.id);
    const seq = seqOf(h, agent.id);

    for (const since of ["abc", -1, seq + 1]) {
      const client = h.stream({ open: [[agent.id, since]] });
      await client.waitFor(isFrame("resync"));
      expect(
        client.frames.map((f) => f.frame.type),
        String(since),
      ).toEqual(["baseline", "resync"]);
      await client.close();
    }
    // Up to date: snapshots and queries publish nothing; the ack publishes the status change.
    const current = h.stream({ open: [[agent.id, seq]] });
    await h.api("POST", `/api/agents/${agent.id}/ack`, {}); // finished → none
    await h.snapshot(agent.id); // already none: no event
    expect((await h.rpc(agent.id, { type: "get_state" })).status).toBe(200); // query: no event
    await current.waitForSeq(agent.id, seq + 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(current.events(agent.id).map(describe)).toEqual(["agent_status"]);
    expect(current.events(agent.id)[0]?.seq).toBe(seq + 1);
  });

  it("resyncs a Last-Event-ID cursor that isn't a seq or is ahead of the log", async () => {
    const h = await start({ fixture: "plain-answer" });
    const agent = await h.open();
    const seq = seqOf(h, agent.id);
    for (const cursor of ["abc", String(seq + 10_000), "-1", ""]) {
      const client = h.stream({
        open: [[agent.id, seq]],
        lastEventId: `${agent.id}:${cursor}`,
      });
      await client.waitFor(isFrame("resync"));
      expect(client.frames, cursor).toEqual([
        { id: "", frame: expect.objectContaining({ type: "baseline" }) },
        { id: `${agent.id}:${seq}`, frame: { type: "resync", agentId: agent.id } },
      ]);
      await client.close();
    }
  });

  it("reconnects mid-run with the last id to the same events as an uninterrupted client", async () => {
    const h = await start({ fixture: "tool-calls", speed: 4 });
    const a = await h.open();
    const b = await h.open();
    const open = [
      [a.id, seqOf(h, a.id)],
      [b.id, seqOf(h, b.id)],
    ] as const;
    const steady = h.stream({ open });
    const first = h.stream({ open });
    await first.waitFor(isFrame("baseline"));
    const run = promptAll(h, [a.id, b.id]);
    await first.until(() =>
      first.events(a.id).length >= 6 && first.events(b.id).length >= 6 ? true : undefined,
    );
    await first.close();
    const lastId = first.lastId as string;

    // Both agents publish while disconnected, so the second connection has events to resume.
    const lastSeq = (client: StreamClient, id: string) => client.events(id).at(-1)?.seq ?? 0;
    await steady.until(
      () =>
        [a.id, b.id].every((id) => lastSeq(steady, id) > lastSeq(first, id)) ? true : undefined,
      10_000,
    );
    const second = h.stream({ open, lastEventId: lastId });
    await run;
    await caughtUp(h, steady, [a.id, b.id]);
    await caughtUp(h, second, [a.id, b.id]);

    expect(second.frames[0]?.id).toBe(lastId);
    for (const id of [a.id, b.id]) {
      expect(second.events(id).length).toBeGreaterThan(0);
      expect([...first.events(id), ...second.events(id)]).toEqual(steady.events(id));
    }
  });

  it("ends a connection whose live backlog passes the limit; replay doesn't count", async () => {
    const h = await start({ fixture: "plain-answer", sse: { maxBacklog: 5 } });
    const agent = await h.open();
    await promptAndSettle(h, agent.id);
    const seq = seqOf(h, agent.id);
    expect(seq).toBeGreaterThan(5);

    const client = h.stream({ open: [[agent.id, 0]] });
    await caughtUp(h, client, [agent.id]);
    expect(client.events(agent.id)).toHaveLength(seq);

    // Six frames queued in one tick, faster than any socket drains them.
    const pipeline = h.manager.require(agent.id).pipeline;
    pipeline.setAttention("none");
    pipeline.setAttention("finished");
    pipeline.setAttention("none");
    await client.done;
    expect(client.events(agent.id).at(-1)?.seq).toBe(seq);

    const resumed = h.stream({ open: [[agent.id, 0]], lastEventId: client.lastId as string });
    await caughtUp(h, resumed, [agent.id]);
    expect(resumed.events(agent.id).map((e) => e.seq)).toEqual([seq + 1, seq + 2, seq + 3]);
  });
});
