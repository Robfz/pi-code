import type { AgentInfo, ServerEvent, SessionEntry, Snapshot } from "@pi-code/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { fixturePath, loadFixture } from "../../../../test/fake-pi.ts";
import {
  type Harness,
  type HarnessOptions,
  type Received,
  replay,
  type SseClient,
  startHarness,
  stateOf,
} from "../testing/http-harness.ts";
import { STUB_ARGS, STUB_BIN } from "../testing/stub-process.ts";

let harness: Harness | undefined;

async function start(opts: HarnessOptions = {}): Promise<Harness> {
  harness = await startHarness(opts);
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

type Of<T extends ServerEvent["type"]> = Extract<ServerEvent, { type: T }>;

const isPi = (type: string) => (r: Received) =>
  r.event.type === "pi" && r.event.event.type === type;
const ofType =
  <T extends ServerEvent["type"]>(type: T) =>
  (r: Received): r is Received & { event: Of<T> } =>
    r.event.type === type;

function entryKinds(entries: readonly SessionEntry[]): string[] {
  return entries.map((e) => (e.type === "message" ? e.message.role : e.type));
}

/** Events of `type` received after `seq`. */
function eventsAfter<T extends ServerEvent["type"]>(
  client: SseClient,
  seq: number,
  type: T,
): Of<T>[] {
  return client.events
    .filter((r) => (r.seq ?? 0) > seq && r.event.type === type)
    .map((r) => r.event as Of<T>);
}

/** Last recorded full `get_entries` response of a fixture. */
function recordedFinalEntries(fixture: string): { entries: SessionEntry[]; leafId: string } {
  const lines = loadFixture(fixturePath(fixture));
  const last = lines
    .filter((l) => {
      const r = l.line as { type?: string; command?: string };
      return l.dir === "out" && r.type === "response" && r.command === "get_entries";
    })
    .at(-1)?.line as { data: { entries: SessionEntry[]; leafId: string } };
  return last.data;
}

async function settle(h: Harness, client: SseClient, agentId: string, fromSeq: number) {
  await client.until(() =>
    client.events.find((r) => (r.seq ?? 0) > fromSeq && isPi("agent_settled")(r)),
  );
  await h.idle(agentId);
}

function seqOf(h: Harness, agentId: string): number {
  return h.manager.require(agentId).pipeline.seq;
}

const STATE = {
  thinkingLevel: "low",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  sessionId: "s1",
  sessionFile: "/tmp/pi-code-test/s1.jsonl",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};

const entry = (id: string, parentId: string | null) => ({
  type: "custom",
  customType: "t",
  data: {},
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
});

/** A recorded query and its response (fake pi answers queries from these). */
function query(id: string, command: Record<string, unknown>, data: unknown) {
  return [
    { t: 0, dir: "in", line: { id, ...command } },
    {
      t: 0,
      dir: "out",
      line: { id, type: "response", command: command.type, success: true, data },
    },
  ];
}

describe("command rules", () => {
  it("rejects commands outside the allowlist and malformed bodies", async () => {
    const h = await start();
    const agent = await h.open();
    for (const type of ["export_html", "bogus", "extension_ui_response"]) {
      const res = await h.rpc(agent.id, { type });
      expect(res.status, type).toBe(400);
      expect(res.body.error?.code, type).toBe("command_not_allowed");
    }
    for (const body of [{}, { type: 42 }, [], { type: "bash" }, { type: "switch_session" }]) {
      const res = await h.rpc(agent.id, body as Record<string, unknown>);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error?.code).toBe("invalid_body");
    }
    const bad = await h.rpc(agent.id, { type: "prompt", message: "x", streamingBehavior: "now" });
    expect(bad.body.error?.code).toBe("invalid_body");
    // A client-sent id is ignored; queries answer with pi's data.
    const state = await h.rpc<{ sessionId: string }>(agent.id, { type: "get_state", id: "mine" });
    expect(state.status).toBe(200);
    expect(state.body.data.sessionId).toBeTypeOf("string");
    expect((await h.rpc("nope", { type: "get_state" })).status).toBe(404);
  });

  it("requires streamingBehavior for a prompt while the agent runs", async () => {
    const h = await start({ fixture: "steer-followup", speed: 1 });
    const agent = await h.open();
    const client = h.sse(agent.id, { since: 0 });
    expect((await h.rpc(agent.id, { type: "prompt", message: "go" })).status).toBe(200);
    await client.waitFor(isPi("agent_start"));
    const res = await h.rpc(agent.id, { type: "prompt", message: "more" });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("streaming_behavior_required");
    // Not forwarded: the fake still accepts the next recorded command.
    expect((await h.rpc(agent.id, { type: "steer", message: "also" })).status).toBe(200);
  });

  it("rejects commands and dialog answers for an exited agent", async () => {
    const h = await start({
      command: () => ({ bin: process.execPath, args: ["-e", "process.exit(1)"] }),
    });
    const { body } = await h.json<{ agent: AgentInfo }>("POST", "/api/agents", {
      cwd: h.project,
    });
    await h.waitForStatus(body.agent.id, "exited");
    const res = await h.rpc(body.agent.id, { type: "get_state" });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("agent_exited");
    const ui = await h.json<{ error: { code: string } }>(
      "POST",
      `/api/agents/${body.agent.id}/ui-responses`,
      { id: "x", cancelled: true },
    );
    expect(ui.status).toBe(409);
    expect(ui.body.error.code).toBe("agent_exited");
  });

  it("answers 504 pi_timeout when pi doesn't respond", async () => {
    const h = await start({
      command: () => ({ bin: STUB_BIN, args: STUB_ARGS }),
      hostOptions: { commandTimeoutMs: 200 },
    });
    const { body } = await h.json<{ agent: AgentInfo }>("POST", "/api/agents", {
      cwd: h.project,
    });
    const res = await h.rpc(body.agent.id, { type: "get_state" });
    expect(res.status).toBe(504);
    expect(res.body.error?.code).toBe("pi_timeout");
  });

  it("rejects switch_session to a session owned by another agent", async () => {
    const h = await start();
    const a = await h.open();
    const b = await h.open();
    const file = h.manager.require(b.id).info().sessionFile as string;
    const res = await h.rpc(a.id, { type: "switch_session", sessionPath: file });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("session_owned");
  });

  it("filters pi-code commands out of get_commands", async () => {
    const h = await start();
    h.fixture = h.writeFixture("commands", [
      ...query("q1", { type: "get_state" }, STATE),
      ...query(
        "q2",
        { type: "get_commands" },
        {
          commands: [
            { name: "pi-code-navigate", source: "extension" },
            { name: "label", source: "extension" },
            { name: "review", source: "prompt" },
          ],
        },
      ),
    ]);
    const agent = await h.open();
    const res = await h.rpc<{ commands: { name: string }[] }>(agent.id, { type: "get_commands" });
    expect(res.status).toBe(200);
    expect(res.body.data.commands.map((c) => c.name)).toEqual(["label", "review"]);
  });

  it("refreshes state and entries after mutating commands, and resets on session changes", async () => {
    const h = await start({ fixture: "entry-types" });
    const agent = await h.open();
    const initial = await h.snapshot(agent.id);
    const client = h.sse(agent.id, { since: initial.seq });

    expect((await h.rpc(agent.id, { type: "prompt", message: "Say hi" })).status).toBe(200);
    await settle(h, client, agent.id, initial.seq);

    // set_session_name: session_info_changed, the session_info entry (no event), then state —
    // all published before the response.
    let seq = seqOf(h, agent.id);
    let res = await h.rpc(agent.id, { type: "set_session_name", name: "s0 entries" });
    expect(res.status).toBe(200);
    await client.waitForSeq(seqOf(h, agent.id));
    expect(
      eventsAfter(client, seq, "entries_appended").flatMap((e) => entryKinds(e.entries)),
    ).toContain("session_info");
    expect(eventsAfter(client, seq, "state")).toHaveLength(1);

    // set_model emits no pi event: the state refresh is what reports it.
    for (const command of [
      { type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4-5" },
      { type: "set_model", provider: "anthropic", modelId: "claude-haiku-4-5" },
      { type: "set_thinking_level", level: "minimal" },
    ]) {
      seq = seqOf(h, agent.id);
      res = await h.rpc(agent.id, command);
      expect(res.status, command.type).toBe(200);
      await client.waitForSeq(seqOf(h, agent.id));
      expect(eventsAfter(client, seq, "state"), command.type).toHaveLength(1);
    }

    // Extension commands run inside the prompt response and add entries without agent events.
    // (The fake's timestamp-based visibility may surface some of them a sync earlier.)
    expect((await h.rpc(agent.id, { type: "prompt", message: "/label s0-label" })).status).toBe(
      200,
    );
    expect((await h.rpc(agent.id, { type: "prompt", message: "/s0-entries" })).status).toBe(200);
    await client.waitForSeq(seqOf(h, agent.id));
    expect(entryKinds(h.manager.require(agent.id).pipeline.transcript.entries)).toEqual(
      expect.arrayContaining(["label", "custom", "custom_message"]),
    );

    seq = seqOf(h, agent.id);
    expect((await h.rpc(agent.id, { type: "prompt", message: "Say bye" })).status).toBe(200);
    await settle(h, client, agent.id, seq);
    seq = seqOf(h, agent.id);
    expect((await h.rpc(agent.id, { type: "prompt", message: "/s0-branch" })).status).toBe(200);
    await client.waitForSeq(seqOf(h, agent.id));
    expect(
      eventsAfter(client, seq, "entries_appended").flatMap((e) => entryKinds(e.entries)),
    ).toContain("branch_summary");
    seq = seqOf(h, agent.id);
    expect((await h.rpc(agent.id, { type: "prompt", message: "Say ok" })).status).toBe(200);
    await settle(h, client, agent.id, seq);

    // Session-changing commands: transcript_reset before the response.
    const beforeFork = h.manager.require(agent.id).info().sessionFile;
    for (const command of [
      { type: "fork", entryId: "3c303b42" },
      { type: "clone" },
      { type: "new_session" },
    ]) {
      seq = seqOf(h, agent.id);
      res = await h.rpc(agent.id, command);
      expect(res.status, command.type).toBe(200);
      // Published before the response: the pipeline is already past it.
      expect(h.manager.require(agent.id).pipeline.snapshot().seq).toBeGreaterThan(seq);
      await client.waitForSeq(seqOf(h, agent.id));
      expect(eventsAfter(client, seq, "transcript_reset"), command.type).toHaveLength(1);
    }
    const final = await h.snapshot(agent.id);
    expect(final.agent.sessionFile).not.toBe(beforeFork);
    const recorded = recordedFinalEntries("entry-types");
    expect(final.transcript.entries.map((e) => e.id)).toEqual(recorded.entries.map((e) => e.id));
    expect(final.transcript.leafId).toBe(recorded.leafId);

    // The whole session replays onto the first snapshot.
    await client.waitForSeq(final.seq);
    const events = client.events.filter((r) => (r.seq ?? 0) <= final.seq).map((r) => r.event);
    expect(replay(initial, events)).toEqual(stateOf(final));
  });
});

describe("bash", () => {
  it("returns 202 and streams bash_output, bash_done, then the entry", async () => {
    const h = await start({ fixture: "bash-command" });
    const agent = await h.open();
    const client = h.sse(agent.id, { since: 0 });
    const commands = [
      { type: "bash", command: "echo one; sleep 0.3; echo two; sleep 0.3; ls" },
      { type: "bash", command: "echo hidden-output", excludeFromContext: true },
      { type: "bash", command: "exit 3" },
    ];
    const ids: string[] = [];
    for (const command of commands) {
      const res = await h.rpc<{ id: string }>(agent.id, command);
      expect(res.status).toBe(202);
      expect(res.body.data.id).toBeTypeOf("string");
      ids.push(res.body.data.id);
      await client.waitFor((r) => r.event.type === "bash_done" && r.event.id === res.body.data.id);
    }
    await h.idle(agent.id);
    await client.waitForSeq(seqOf(h, agent.id));

    const first = ids[0] as string;
    const output = client.events.filter(ofType("bash_output")).filter((r) => r.event.id === first);
    expect(output.length).toBe(3);
    expect(output.map((r) => r.event.command)).toEqual(Array(3).fill(commands[0]?.command));
    expect(output.map((r) => r.event.delta).join("")).toContain("one\ntwo\n");

    const done = client.events.filter(ofType("bash_done"));
    expect(done.map((r) => r.event.id)).toEqual(ids);
    expect(done.map((r) => r.event.result.exitCode)).toEqual([0, 0, 3]);
    expect(done[0]?.event.command).toBe(commands[0]?.command);
    // Each bash_done is followed by its bashExecution entry.
    for (const d of done) {
      const next = client.events.find((r) => r.seq === (d.seq as number) + 1)?.event;
      expect(next?.type).toBe("entries_appended");
      expect(entryKinds((next as Of<"entries_appended">).entries)).toContain("bashExecution");
    }
    const snap = await h.snapshot(agent.id);
    expect(snap.live.bash).toEqual({});
    expect(entryKinds(snap.transcript.entries).filter((k) => k === "bashExecution")).toHaveLength(
      3,
    );
  });
});

describe("dialogs", () => {
  it("round-trips the extension-dialog fixture and expires the timed dialog", async () => {
    const h = await start({ fixture: "extension-dialog" });
    const agent = await h.open();
    const client = h.sse(agent.id, { since: 0 });
    const prompt = h.rpc(agent.id, { type: "prompt", message: "/s0-dialog" });

    const answers: Array<[string, Record<string, unknown>]> = [
      ["select", { value: "banana" }],
      ["confirm", { confirmed: true }],
      ["input", { value: "hello from s0" }],
      ["editor", { cancelled: true }],
    ];
    for (const [method, answer] of answers) {
      const req = await client.waitFor(
        (r) => r.event.type === "ui_request" && r.event.request.method === method,
      );
      const id = (req.event as Of<"ui_request">).request.id;
      await h.idle(agent.id);
      expect(h.manager.require(agent.id).info().attention, method).toBe("input");
      const snap = await h.snapshot(agent.id);
      expect(snap.live.dialogs.map((d) => d.request.id)).toEqual([id]);

      const res = await h.api("POST", `/api/agents/${agent.id}/ui-responses`, { id, ...answer });
      expect(res.status, method).toBe(204);
      await client.waitFor((r) => r.event.type === "ui_resolved" && r.event.id === id);
      // Answered: no longer pending.
      const again = await h.json<{ error: { code: string } }>(
        "POST",
        `/api/agents/${agent.id}/ui-responses`,
        { id, ...answer },
      );
      expect(again.status).toBe(404);
      expect(again.body.error.code).toBe("dialog_not_found");
    }
    expect((await prompt).status).toBe(200);

    // The select with a 1.5 s timeout: pi resolves it silently; the server's timer publishes it.
    const timed = await client.waitFor(
      (r) =>
        r.event.type === "ui_request" &&
        r.event.request.method === "select" &&
        "timeout" in r.event.request &&
        r.event.request.timeout === 1500,
    );
    const timedEvent = timed.event as Of<"ui_request">;
    const snap = await h.snapshot(agent.id);
    expect(snap.live.dialogs).toEqual([
      {
        request: timedEvent.request,
        receivedAt: timedEvent.receivedAt,
        expiresAt: timedEvent.receivedAt + 1500,
      },
    ]);
    const resolved = await client.waitFor(
      (r) => r.event.type === "ui_resolved" && r.event.id === timedEvent.request.id,
      4_000,
    );
    expect(Date.now()).toBeGreaterThanOrEqual(timedEvent.receivedAt + 1500);
    expect(resolved.seq).toBeGreaterThan(timed.seq as number);
    const expired = await h.json<{ error: { code: string } }>(
      "POST",
      `/api/agents/${agent.id}/ui-responses`,
      { id: timedEvent.request.id, value: "x" },
    );
    expect(expired.body.error.code).toBe("dialog_not_found");

    const final = await h.snapshot(agent.id);
    expect(final.live.dialogs).toEqual([]);
    expect(final.live.title).toBeTypeOf("string");
    expect(final.live.editorText?.text).toBeTypeOf("string");
    expect(final.live.notices.length).toBeGreaterThan(0);
  });

  it("validates dialog answers", async () => {
    const h = await start();
    const agent = await h.open();
    for (const body of [{}, { id: "x" }, { id: "x", value: 1 }, { id: "x", cancelled: false }]) {
      const res = await h.api("POST", `/api/agents/${agent.id}/ui-responses`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const res = await h.api("POST", `/api/agents/${agent.id}/ui-responses`, {
      id: "nope",
      value: "x",
    });
    expect(res.status).toBe(404);
  });
});

describe("transcript resets", () => {
  it("resets with the compaction entry after a successful compaction", async () => {
    const h = await start({ fixture: "compaction" });
    const agent = await h.open();
    const initial = await h.snapshot(agent.id);
    const client = h.sse(agent.id, { since: initial.seq });

    let seq = seqOf(h, agent.id);
    expect((await h.rpc(agent.id, { type: "prompt", message: "PINEAPPLE" })).status).toBe(200);
    await settle(h, client, agent.id, seq);

    // Too small to compact: pi_error, and no reset.
    seq = seqOf(h, agent.id);
    const failed = await h.rpc(agent.id, { type: "compact" });
    expect(failed.status).toBe(502);
    expect(failed.body.error?.code).toBe("pi_error");
    await h.idle(agent.id);
    expect(eventsAfter(client, seq, "transcript_reset")).toHaveLength(0);

    for (let i = 1; i <= 3; i++) {
      const command = `seq 1 2100 | sed 's/$/ filler line ${i} lorem ipsum/'`;
      const res = await h.rpc<{ id: string }>(agent.id, { type: "bash", command });
      expect(res.status).toBe(202);
      await client.waitFor((r) => r.event.type === "bash_done" && r.event.id === res.body.data.id);
    }
    seq = seqOf(h, agent.id);
    expect((await h.rpc(agent.id, { type: "prompt", message: "2+2" })).status).toBe(200);
    await settle(h, client, agent.id, seq);

    seq = seqOf(h, agent.id);
    const compact = await h.rpc(agent.id, { type: "compact" });
    expect(compact.status).toBe(200);
    await client.waitForSeq(seqOf(h, agent.id));
    const labels = client.events
      .filter((r) => (r.seq ?? 0) > seq)
      .map((r) => (r.event.type === "pi" ? `pi:${r.event.event.type}` : r.event.type));
    expect(labels.slice(0, 3)).toEqual([
      "pi:compaction_start",
      "pi:compaction_end",
      "transcript_reset",
    ]);
    const [reset] = eventsAfter(client, seq, "transcript_reset");
    const compaction = reset?.transcript.entries.find((e) => e.type === "compaction");
    expect(compaction).toBeDefined();
    expect(reset?.transcript.leafId).toBe(compaction?.id);
    expect(reset?.state.sessionId).toBeTypeOf("string");

    seq = seqOf(h, agent.id);
    expect((await h.rpc(agent.id, { type: "prompt", message: "codeword?" })).status).toBe(200);
    await settle(h, client, agent.id, seq);
    const final = await h.snapshot(agent.id);
    const recorded = recordedFinalEntries("compaction");
    expect(final.transcript.entries.map((e) => e.id)).toEqual(recorded.entries.map((e) => e.id));
    expect(final.transcript.leafId).toBe(recorded.leafId);

    await client.waitForSeq(final.seq);
    const events = client.events.filter((r) => (r.seq ?? 0) <= final.seq).map((r) => r.event);
    expect(replay(initial, events)).toEqual(stateOf(final));
  });

  async function resetScenario(followUp: Record<string, unknown>[]): Promise<{
    reset: Of<"transcript_reset">;
    before: Snapshot;
  }> {
    const h = await start();
    h.fixture = h.writeFixture("reset", [
      ...query("q1", { type: "get_state" }, STATE),
      ...query(
        "qa",
        { type: "get_entries" },
        { entries: [entry("e1", null), entry("e2", "e1")], leafId: "e2" },
      ),
      { t: 1, dir: "in", line: { id: "g1", type: "set_session_name", name: "x" } },
      {
        t: 1,
        dir: "out",
        line: { id: "g1", type: "response", command: "set_session_name", success: true },
      },
      ...followUp,
    ]);
    const agent = await h.open();
    const before = await h.snapshot(agent.id);
    const client = h.sse(agent.id, { since: before.seq });
    expect((await h.rpc(agent.id, { type: "set_session_name", name: "x" })).status).toBe(200);
    await client.waitForSeq(seqOf(h, agent.id));
    const resets = eventsAfter(client, before.seq, "transcript_reset");
    expect(resets).toHaveLength(1);
    // A state refresh follows (set_session_name mutates state).
    expect(eventsAfter(client, before.seq, "state")).toHaveLength(1);
    return { reset: resets[0] as Of<"transcript_reset">, before };
  }

  it("resets when pi no longer knows the last entry", async () => {
    const { reset, before } = await resetScenario(
      query(
        "qc",
        { type: "get_entries" },
        { entries: [entry("x1", null), entry("x2", "x1")], leafId: "x2" },
      ),
    );
    expect(before.transcript.entries.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(reset.transcript.entries.map((e) => e.id)).toEqual(["x1", "x2"]);
    expect(reset.transcript.leafId).toBe("x2");
  });

  it("resets when the leaf moved without new entries", async () => {
    const { reset } = await resetScenario(
      query("qc", { type: "get_entries", since: "e2" }, { entries: [], leafId: "e1" }),
    );
    expect(reset.transcript.entries.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(reset.transcript.leafId).toBe("e1");
  });
});
