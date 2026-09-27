import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import { chunksOf, fakePiCommand, isAlive, spawnStub } from "../testing/stub-process.ts";
import type { PiEvent, PiUiRequest } from "../types-temp.ts";
import { AgentHost, type AgentHostOptions, type HostStatus } from "./agent-host.ts";

const hosts: AgentHost[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stubHost(opts: AgentHostOptions = {}, env: Record<string, string> = {}) {
  const host = new AgentHost(spawnStub(env), { idPrefix: "t", ...opts });
  hosts.push(host);
  return host;
}

function fakePi(fixture: string, opts: AgentHostOptions = {}) {
  const { bin, args } = fakePiCommand(fixture);
  const host = AgentHost.spawn(bin, args, { cwd: process.cwd(), ...opts });
  hosts.push(host);
  return host;
}

function record(host: AgentHost) {
  const seen: Array<{ kind: "event"; event: PiEvent } | { kind: "ui"; request: PiUiRequest }> = [];
  host.on("event", (event) => seen.push({ kind: "event", event }));
  host.on("ui_request", (request) => seen.push({ kind: "ui", request }));
  return seen;
}

const line = (rec: unknown, eol = "\n") => `${JSON.stringify(rec)}${eol}`;
const response = (id: string, data?: unknown, command = "x") => ({
  id,
  type: "response",
  command,
  success: true,
  ...(data === undefined ? {} : { data }),
});

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected a rejection");
}

describe("AgentHost framing (stub process)", () => {
  it("handles U+2028, CRLF lines and chunks split mid-code-point", async () => {
    const host = stubHost();
    const seen = record(host);
    const text = "a\u2028b\u2029c é€😀";
    const ev = line({ type: "message_update", text }, "\r\n");
    const resp = line(response("t1", { ok: "✓" }), "\r\n");
    const bytes = Buffer.from(ev + resp, "utf8");
    // Split inside "€" (3 bytes) and inside "😀" (4 bytes), and in the middle of the CRLF.
    const euro = bytes.indexOf(Buffer.from("€"));
    const smile = bytes.indexOf(Buffer.from("😀"));
    const cr = bytes.indexOf(Buffer.from("\r\n"));
    const data = await host.send({
      type: "script",
      chunks: chunksOf(bytes, [euro + 1, euro + 2, smile + 3, cr + 1]),
    });
    expect(data).toEqual({ ok: "✓" });
    expect(seen).toEqual([{ kind: "event", event: { type: "message_update", text } }]);
  });

  it("routes interleaved responses, events and UI requests", async () => {
    const host = stubHost();
    const seen = record(host);
    const settled = new Promise<void>((r) =>
      host.on("event", (e) => e.type === "agent_settled" && r()),
    );
    const order: string[] = [];
    const first = host.send({ type: "first" }).then((d) => {
      order.push("first");
      return d;
    });
    const ui = { type: "extension_ui_request", id: "u1", method: "confirm", title: "?" };
    const script =
      line({ type: "agent_start" }) +
      line(response("t2", "two")) +
      line(ui) +
      line({ type: "message_update", n: 1 }) +
      line(response("t1", "one")) +
      line({ type: "agent_settled" });
    const second = host.send({ type: "second", chunks: chunksOf(script) }).then((d) => {
      order.push("second");
      return d;
    });
    expect(await Promise.all([first, second])).toEqual(["one", "two"]);
    expect(order).toEqual(["second", "first"]);
    await settled;
    expect(seen).toEqual([
      { kind: "event", event: { type: "agent_start" } },
      { kind: "ui", request: ui },
      { kind: "event", event: { type: "message_update", n: 1 } },
      { kind: "event", event: { type: "agent_settled" } },
    ]);
  });

  it("rejects with pi_error when pi answers success: false", async () => {
    const host = stubHost();
    const err = await rejection(
      host.send({
        type: "script",
        chunks: chunksOf(
          line({ id: "t1", type: "response", command: "x", success: false, error: "nope" }),
        ),
      }),
    );
    expect(err.code).toBe("pi_error");
    expect(err.message).toBe("nope");
    expect(err.status).toBe(502);
  });

  it("rejects with pi_timeout when no response arrives in time", async () => {
    const host = stubHost({ commandTimeoutMs: 50 });
    const err = await rejection(host.send({ type: "silent" }));
    expect(err.code).toBe("pi_timeout");
    // A late response is reported, not delivered.
    const errors: string[] = [];
    host.on("protocol_error", (e) => errors.push(e.message));
    await host.send({
      type: "script",
      chunks: chunksOf(line(response("t1", 1)) + line(response("t2", 2))),
    });
    expect(errors).toEqual(["response to unknown id t1"]);
  });

  it("reports unparseable lines and id-less responses as protocol errors", async () => {
    const host = stubHost();
    const errors: string[] = [];
    host.on("protocol_error", (e) => errors.push(e.message));
    await host.send({
      type: "script",
      chunks: chunksOf(
        "not json\n" +
          line({ type: "response", command: "parse", success: false, error: "bad" }) +
          line(response("t1")),
      ),
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^unparseable stdout line/);
    expect(errors[1]).toBe("response without id: bad");
  });

  it("rejects every pending command with agent_exited when pi exits mid-command", async () => {
    const host = stubHost();
    const statuses: HostStatus[] = [];
    host.on("status", (s) => statuses.push(s));
    const pending = host.send({ type: "slow" });
    const dying = host.send({ type: "die", stderr: ["boom 1", "boom 2"], exit: 3 });
    const [e1, e2] = await Promise.all([rejection(pending), rejection(dying)]);
    expect(e1.code).toBe("agent_exited");
    expect(e2.code).toBe("agent_exited");
    expect(e1.status).toBe(409);
    expect(host.status).toBe("exited");
    expect(statuses).toEqual(["exited"]);
    expect(host.exitInfo).toMatchObject({ code: 3, signal: null, requested: false });
    expect(host.stderrTail).toEqual(["boom 1", "boom 2"]);
    expect((await rejection(host.send({ type: "later" }))).code).toBe("agent_exited");
    expect(() =>
      host.sendNoReply({ type: "extension_ui_response", id: "u", cancelled: true }),
    ).toThrow(ApiError);
  });

  it("keeps a bounded stderr tail", async () => {
    const host = stubHost({ stderrTailLines: 200 });
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    const last = new Promise<void>((r) => host.on("stderr", (l) => l === "line 249" && r()));
    await host.send({ type: "noise", stderr: lines, chunks: chunksOf(line(response("t1"))) });
    await last;
    const tail = host.stderrTail;
    expect(tail).toHaveLength(200);
    expect(tail[0]).toBe("line 50");
    expect(tail[199]).toBe("line 249");
  });

  it("honors stdin backpressure with large commands", async () => {
    const host = stubHost();
    const big = "x".repeat(2 * 1024 * 1024);
    const sizes = await Promise.all(
      Array.from({ length: 5 }, () => host.send<number>({ type: "echo_size", big })),
    );
    for (const s of sizes) expect(s).toBeGreaterThan(big.length);
  });

  it("close() ends stdin and the process exits on its own", async () => {
    const host = stubHost();
    const statuses: HostStatus[] = [];
    host.on("status", (s) => statuses.push(s));
    const pid = host.pid as number;
    const exit = await host.close();
    expect(exit).toMatchObject({ code: 0, signal: null, requested: true });
    expect(statuses).toEqual(["closing", "exited"]);
    expect(isAlive(pid)).toBe(false);
    expect((await rejection(host.send({ type: "x" }))).code).toBe("agent_exited");
  });

  it("close() escalates to SIGTERM", async () => {
    const host = stubHost({ closeTermMs: 50, closeKillMs: 5_000 }, { STUB_IGNORE_EOF: "1" });
    expect(await host.close()).toMatchObject({ signal: "SIGTERM", requested: true });
  });

  it("close() escalates to SIGKILL when SIGTERM is ignored", async () => {
    const host = stubHost(
      { closeTermMs: 50, closeKillMs: 200 },
      { STUB_IGNORE_EOF: "1", STUB_IGNORE_TERM: "1" },
    );
    // Let the stub install its SIGTERM handler first.
    await host.send({ type: "ready", chunks: chunksOf(line(response("t1"))) });
    expect(await host.close()).toMatchObject({ signal: "SIGKILL", requested: true });
  });

  it("reports a spawn failure as an exit", async () => {
    const host = AgentHost.spawn("/nonexistent/pi-binary", [], { cwd: process.cwd() });
    hosts.push(host);
    const exit = await host.exited;
    expect(exit.error?.message).toMatch(/ENOENT/);
    const err = await rejection(host.send({ type: "get_state" }));
    expect(err.code).toBe("agent_exited");
    expect(err.message).toMatch(/failed to start/);
  });
});

describe("AgentHost with fake pi", () => {
  it("replays a prompt: response, events in order, queries answered", async () => {
    const host = fakePi("plain-answer");
    const seen = record(host);
    const settled = new Promise<void>((r) =>
      host.on("event", (e) => e.type === "agent_settled" && r()),
    );
    const state = await host.send<{ sessionId: string; isStreaming: boolean }>({
      type: "get_state",
    });
    expect(typeof state.sessionId).toBe("string");
    await host.send({ type: "prompt", message: "In one short sentence: what is a monad?" });
    // Queries interleave with the replayed events.
    const entries = await host.send<{ entries: unknown[] }>({ type: "get_entries" });
    expect(Array.isArray(entries.entries)).toBe(true);
    await settled;
    const types = seen.map((s) => (s.kind === "event" ? s.event.type : `ui:${s.request.method}`));
    expect(types[0]).toBe("ui:setStatus");
    expect(types.slice(1, 3)).toEqual(["agent_start", "turn_start"]);
    expect(types.slice(-3)).toEqual(["turn_end", "agent_end", "agent_settled"]);
    expect(types.filter((t) => t === "message_update").length).toBeGreaterThan(10);
    expect(host.stderrTail.some((l) => l.includes("pi-web-access"))).toBe(true);
    expect(await host.close()).toMatchObject({ code: 0, requested: true });
  });

  it("delivers a JSON string containing U+2028 intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-code-host-"));
    tmpDirs.push(dir);
    const fixture = join(dir, "u2028.jsonl");
    const text = "before\u2028after\u2029end";
    const fx = [
      { t: 0, dir: "in", line: { id: "r-1", type: "prompt", message: "hi" } },
      { t: 1, dir: "out", line: { id: "r-1", type: "response", command: "prompt", success: true } },
      { t: 2, dir: "out", line: { type: "message_update", delta: text } },
      { t: 3, dir: "out", line: { type: "agent_settled" } },
    ];
    writeFileSync(fixture, fx.map((l) => JSON.stringify(l)).join("\n"));
    const host = fakePi(fixture);
    const seen = record(host);
    const settled = new Promise<void>((r) =>
      host.on("event", (e) => e.type === "agent_settled" && r()),
    );
    await host.send({ type: "prompt", message: "hi" });
    await settled;
    expect(seen).toEqual([
      { kind: "event", event: { type: "message_update", delta: text } },
      { kind: "event", event: { type: "agent_settled" } },
    ]);
  });

  it("round-trips dialogs with sendNoReply", async () => {
    const host = fakePi("extension-dialog");
    const answers: Record<string, object> = {
      select: { value: "banana" },
      confirm: { confirmed: true },
      input: { value: "hello from s0" },
      editor: { cancelled: true },
    };
    const dialogs: string[] = [];
    host.on("ui_request", (req) => {
      const answer = answers[req.method];
      if (!answer || req.timeout !== undefined) return;
      dialogs.push(req.method);
      host.sendNoReply({ type: "extension_ui_response", id: req.id, ...answer } as never);
    });
    await host.send({ type: "prompt", message: "/s0-dialog" });
    expect(dialogs).toEqual(["select", "confirm", "input", "editor"]);
  });
});
