/**
 * End-to-end smoke test of a running pi-code server against the real pi, through the HTTP/SSE
 * API. Spends real tokens (claude-haiku-4-5, thinking low; a few cents).
 *
 * Start the server first (the wrapper adds the `/smoke-dialog` extension; without it the
 * dialog part of scenario 8 is skipped):
 *   NODE_ENV=development PI_CODE_PORT=4199 PI_CODE_PI_BIN=$PWD/scripts/smoke-pi.sh \
 *     pnpm --filter @pi-code/server start > /tmp/pi-code-smoke.log 2>&1 &
 * Then (from packages/server):
 *   SMOKE_URL=http://localhost:4199 pnpm exec tsx ../../scripts/smoke.ts [scenario numbers…]
 *
 * Creates scratch dirs under ~/tmp and deletes them at the end with the sessions pi wrote for
 * them in ~/.pi/agent/sessions (unless SMOKE_KEEP=1). Scenario 12 (project trust) backs up
 * ~/.pi/agent/trust.json and restores it byte-identically. Prints PASS / FAIL / SKIP per scenario;
 * SMOKE_DEBUG=1 also prints the event types a failed scenario saw.
 */
// biome-ignore-all lint/suspicious/noExplicitAny: loosely typed JSON from the wire
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { applyServerEventToCaches, reduceLive } from "../packages/protocol/src/index.ts";

type Json = Record<string, any>;

const BASE = (process.env.SMOKE_URL ?? "http://localhost:4180").replace(/\/$/, "");
const ORIGIN = new URL(BASE).origin;
const ONLY = new Set(process.argv.slice(2).map(Number));
const TURN_TIMEOUT = 120_000;

// ---------------------------------------------------------------------------
// HTTP helpers

async function api(method: string, path: string, body?: unknown, headers: Json = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(method === "GET" ? {} : { "Content-Type": "application/json", Origin: ORIGIN }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function rpc(agentId: string, command: Json) {
  return api("POST", `/api/agents/${agentId}/rpc`, command);
}

async function rpcOk(agentId: string, command: Json): Promise<any> {
  const r = await rpc(agentId, command);
  if (r.status !== 200 && r.status !== 202) {
    throw new Error(`rpc ${command.type} → ${r.status} ${r.text.slice(0, 300)}`);
  }
  return r.json.data;
}

/** Raw request with an arbitrary Host header (fetch doesn't let us set it). */
function rawRequest(
  method: string,
  path: string,
  headers: Json,
): Promise<{ status: number; body: string }> {
  const url = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, method, path, headers },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(method === "GET" ? undefined : "{}");
  });
}

// ---------------------------------------------------------------------------
// Minimal client of one agent on the live stream

interface SseEvent {
  /** The event's seq; absent on `resync` / `agent_closed` frames. */
  seq?: number;
  data: Json;
}

/**
 * `GET /api/stream?open=<agentId>:<since>`, keeping that agent's frames: each `event` frame as
 * its `ServerEvent` with the frame's seq, `resync` and `agent_closed` frames as they are.
 * `lastEventId` is sent as `Last-Event-ID: <agentId>:<lastEventId>`.
 */
class Sse {
  readonly events: SseEvent[] = [];
  /** Seq of the last event received. */
  lastId: number | undefined;
  ended = false;
  private readonly ctrl = new AbortController();
  private waiters: (() => void)[] = [];
  readonly done: Promise<void>;

  private readonly agentId: string;

  constructor(agentId: string, since: number, lastEventId?: number | string) {
    this.agentId = agentId;
    const headers: Json = {};
    if (lastEventId !== undefined) headers["Last-Event-ID"] = `${agentId}:${lastEventId}`;
    const open = encodeURIComponent(`${agentId}:${since}`);
    this.done = this.run(`${BASE}/api/stream?open=${open}`, headers);
  }

  private async run(url: string, headers: Json) {
    try {
      const res = await fetch(url, { headers, signal: this.ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk as Uint8Array, { stream: true });
        let idx = buf.indexOf("\n\n");
        while (idx >= 0) {
          this.onFrame(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
          idx = buf.indexOf("\n\n");
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") console.error("  [sse]", (e as Error).message);
    } finally {
      this.ended = true;
      this.wake();
    }
  }

  private onFrame(message: string) {
    const data: string[] = [];
    let named = false;
    for (const line of message.split("\n")) {
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("event:")) named = true; // ping
    }
    if (data.length === 0 || named) return;
    const frame: Json = JSON.parse(data.join("\n"));
    if (frame.agentId !== this.agentId) return;
    if (frame.type === "event") {
      this.lastId = frame.seq;
      this.events.push({ seq: frame.seq, data: frame.event });
    } else if (frame.type === "resync" || frame.type === "agent_closed") {
      this.events.push({ data: frame });
    } else return;
    this.wake();
  }

  private wake() {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  /** Waits for an event matching `pred` at index ≥ `from`; returns its index. */
  async waitFor(pred: (e: Json) => boolean, what: string, timeoutMs = TURN_TIMEOUT, from = 0) {
    const deadline = Date.now() + timeoutMs;
    let i = from;
    for (;;) {
      for (; i < this.events.length; i++) {
        if (pred((this.events[i] as SseEvent).data)) return i;
      }
      if (this.ended) throw new Error(`SSE ended while waiting for ${what}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  data(from = 0): Json[] {
    return this.events.slice(from).map((e) => e.data);
  }

  close() {
    this.ctrl.abort();
  }
}

const isPi = (type: string) => (e: Json) => e.type === "pi" && e.event.type === type;
const textDelta = (e: Json) =>
  e.type === "pi" &&
  e.event.type === "message_update" &&
  e.event.assistantMessageEvent?.type === "text_delta";
const deltasText = (events: Json[]) =>
  events
    .filter(textDelta)
    .map((e) => e.event.assistantMessageEvent.delta as string)
    .join("");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function entryText(entry: Json): string {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: Json) => b.type === "text")
    .map((b: Json) => b.text)
    .join("");
}

const messageEntries = (t: Json, role: string) =>
  (t.entries as Json[]).filter((e) => e.type === "message" && e.message.role === role);

// ---------------------------------------------------------------------------
// Scenario runner

const results: { n: number; name: string; status: "PASS" | "FAIL" | "SKIP"; note?: string }[] = [];

/** The main agent's stream, for `SMOKE_DEBUG=1` dumps of a failed scenario's events. */
let debugSse: Sse | undefined;

function describeEvent(e: Json): string {
  if (e.type === "pi") {
    const sub = e.event.assistantMessageEvent?.type ?? e.event.message?.role ?? "";
    const extra = e.event.message?.stopReason ? `/${e.event.message.stopReason}` : "";
    return `pi:${e.event.type}${sub ? `(${sub}${extra})` : ""}`;
  }
  if (e.type === "agent_status") return `agent_status(${e.agent.status},${e.agent.attention})`;
  return e.type;
}

async function scenario(n: number, name: string, fn: () => Promise<unknown>) {
  if (ONLY.size > 0 && !ONLY.has(n)) return;
  const started = Date.now();
  const firstEvent = debugSse?.events.length ?? 0;
  try {
    const result = await fn();
    const note = typeof result === "string" ? result : undefined;
    const skip = typeof note === "string" && note.startsWith("SKIP");
    results.push({ n, name, status: skip ? "SKIP" : "PASS", ...(note ? { note } : {}) });
    console.log(
      `${skip ? "SKIP" : "PASS"} ${n}. ${name} (${Date.now() - started} ms)${note ? ` — ${note}` : ""}`,
    );
  } catch (e) {
    results.push({ n, name, status: "FAIL", note: (e as Error).message });
    console.log(`FAIL ${n}. ${name}: ${(e as Error).message}`);
    if (process.env.SMOKE_DEBUG && debugSse) {
      const evs = debugSse.data(firstEvent).map(describeEvent);
      const collapsed: string[] = [];
      for (const d of evs) {
        const last = collapsed.at(-1);
        const m = last && /^(.*) ×(\d+)$/.exec(last);
        if (last === d) collapsed[collapsed.length - 1] = `${d} ×2`;
        else if (m && m[1] === d) collapsed[collapsed.length - 1] = `${d} ×${Number(m[2]) + 1}`;
        else collapsed.push(d);
      }
      console.log(`  events: ${collapsed.join(", ")}`);
    }
  }
}

/** Sends a prompt and waits for `agent_settled` on `sse`; returns the events of the run. */
async function promptAndSettle(agentId: string, sse: Sse, message: string) {
  const from = sse.events.length;
  await rpcOk(agentId, { type: "prompt", message });
  const end = await sse.waitFor(isPi("agent_settled"), "agent_settled", TURN_TIMEOUT, from);
  // entries_appended for the settle sync follows agent_settled in the same batch.
  await sleep(200);
  return { from, end, events: sse.data(from) };
}

/**
 * pi processes spawned by the server: descendants of the process listening on the server's
 * port whose title is `pi` (pi sets `process.title`, so its argv isn't visible to ps).
 */
function piPids(): number[] {
  let server: number;
  try {
    const port = new URL(BASE).port || "80";
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
    });
    server = Number(out.trim().split("\n")[0]);
  } catch {
    return [];
  }
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [pid, ppid, ...comm] = l.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), comm: comm.join(" ") };
    });
  const descendants = new Set([server]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (descendants.has(r.ppid) && !descendants.has(r.pid)) {
        descendants.add(r.pid);
        grew = true;
      }
    }
  }
  return rows.filter((r) => descendants.has(r.pid) && r.comm === "pi").map((r) => r.pid);
}

/** The server's cached transcript (snapshot) must match pi's own `get_entries`. */
async function assertTranscriptConsistent(agentId: string) {
  const snap = (await api("GET", `/api/agents/${agentId}/snapshot`)).json;
  const pi = await rpcOk(agentId, { type: "get_entries" });
  const a = snap.transcript.entries.map((e: Json) => e.id);
  const b = pi.entries.map((e: Json) => e.id);
  assert(
    JSON.stringify(a) === JSON.stringify(b),
    `snapshot transcript ≠ pi get_entries (${a.length} vs ${b.length} entries)`,
  );
  assert(snap.transcript.leafId === pi.leafId, `leafId ${snap.transcript.leafId} ≠ ${pi.leafId}`);
  return snap;
}

// ---------------------------------------------------------------------------

async function main() {
  const scratch = join(homedir(), "tmp", `pi-code-smoke-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });
  writeFileSync(
    join(scratch, "README.md"),
    "# smoke\n\nScratch project for the pi-code smoke test.\n",
  );
  writeFileSync(join(scratch, "notes.txt"), "first line\nsecond line\n");
  execFileSync("git", ["init", "-q"], { cwd: scratch });
  execFileSync("git", ["add", "."], { cwd: scratch });
  execFileSync(
    "git",
    ["-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-qm", "init"],
    { cwd: scratch },
  );
  console.log(`server ${BASE}, scratch ${scratch}`);

  let agentId = "";
  let sse: Sse | undefined;
  const pidsBefore = new Set(piPids());
  let agentPids: number[] = [];

  await scenario(1, "health, SPA, guards", async () => {
    const h = await api("GET", "/api/health");
    assert(h.status === 200 && h.json?.ok === true, `health ${h.status} ${h.text}`);
    assert(typeof h.json.piVersion === "string" && h.json.piVersion !== "", "no piVersion");
    const index = await api("GET", "/");
    assert(index.status === 200, `GET / → ${index.status}`);
    assert(index.headers.get("content-type")?.includes("text/html"), "GET / not html");
    assert(/<div id="root"|<script/i.test(index.text), "GET / is not the SPA index");
    const route = await api("GET", "/agents/some-client-route");
    assert(route.status === 200 && route.text === index.text, "client route not served index");
    const asset = /src="(\/assets\/[^"]+)"/.exec(index.text)?.[1];
    if (asset) {
      const a = await api("GET", asset);
      assert(a.status === 200, `asset ${asset} → ${a.status}`);
      assert(a.headers.get("cache-control")?.includes("immutable"), "asset not immutable");
    }
    const missingAsset = await api("GET", "/assets/nope-123.js");
    assert(missingAsset.status === 404, `missing asset → ${missingAsset.status}`);
    const apiMiss = await api("GET", "/api/nope");
    assert(
      apiMiss.status === 404 && apiMiss.json?.error?.code === "not_found",
      "/api/nope swallowed",
    );
    const agentMiss = await api("GET", "/api/agents/nope/snapshot");
    assert(agentMiss.json?.error?.code === "agent_not_found", "agent_not_found expected");
    const badHost = await rawRequest("GET", "/api/health", { Host: "evil.example.com" });
    assert(
      badHost.status === 403 && badHost.body.includes("forbidden_host"),
      `bad host → ${badHost.status}`,
    );
    const rebinding = await rawRequest("GET", "/", { Host: "evil.example.com:4180" });
    assert(rebinding.status === 403, `bad host on / → ${rebinding.status}`);
    const badOrigin = await api(
      "POST",
      "/api/agents",
      { cwd: scratch },
      { Origin: "http://evil.example.com" },
    );
    assert(
      badOrigin.status === 403 && badOrigin.json?.error?.code === "forbidden_origin",
      `bad origin → ${badOrigin.status}`,
    );
    const noOrigin = await rawRequest("POST", "/api/agents", {
      Host: new URL(BASE).host,
      "Content-Type": "application/json",
    });
    assert(noOrigin.status === 403, `no origin → ${noOrigin.status}`);
    const badType = await api("POST", "/api/agents", undefined, { "Content-Type": "text/plain" });
    assert(
      badType.status === 400 && badType.json?.error?.code === "invalid_body",
      `text/plain → ${badType.status}`,
    );
    const outside = await api("POST", "/api/agents", { cwd: "/tmp" });
    assert(
      outside.status === 400 && outside.json?.error?.code === "outside_home",
      `outside home → ${outside.status} ${outside.text}`,
    );
  });

  await scenario(2, "open agent → ready; snapshot", async () => {
    const r = await api("POST", "/api/agents", { cwd: scratch });
    assert(r.status === 201, `open → ${r.status} ${r.text}`);
    const info = r.json.agent;
    agentId = info.id;
    assert(info.status === "starting", `initial status ${info.status}`);
    sse = new Sse(agentId, 0);
    debugSse = sse;
    await sse.waitFor(
      (e) => e.type === "agent_status" && e.agent.status === "ready",
      "ready",
      60_000,
    );
    agentPids = piPids().filter((p) => !pidsBefore.has(p));
    const model = await rpcOk(agentId, {
      type: "set_model",
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
    });
    assert(model?.id === "claude-haiku-4-5", `set_model → ${JSON.stringify(model).slice(0, 200)}`);
    await rpcOk(agentId, { type: "set_thinking_level", level: "low" });
    const stateIdx = await sse.waitFor(
      (e) =>
        e.type === "state" &&
        e.state.model?.id === "claude-haiku-4-5" &&
        e.state.thinkingLevel === "low",
      "state event with haiku/low",
      10_000,
    );
    const snap = (await api("GET", `/api/agents/${agentId}/snapshot`)).json;
    assert(snap.agent.status === "ready", "snapshot agent not ready");
    assert(snap.state && snap.state.model?.id === "claude-haiku-4-5", "snapshot state model");
    assert(Array.isArray(snap.transcript?.entries), "snapshot transcript");
    assert(snap.stats && typeof snap.stats === "object", "snapshot stats null");
    assert(
      typeof snap.seq === "number" && snap.seq >= (sse.events[stateIdx]?.seq ?? 0),
      "snapshot seq",
    );
    const kinds = snap.transcript.entries.map((e: Json) => e.type);
    assert(
      kinds.includes("model_change") && kinds.includes("thinking_level_change"),
      `entries: ${kinds}`,
    );
    const list = (await api("GET", "/api/agents")).json.agents;
    assert(
      list.some((a: Json) => a.id === agentId),
      "agent not listed",
    );
    return `pi pids ${agentPids.join(",") || "?"}`;
  });

  if (!agentId || !sse) {
    console.log("no agent; stopping");
    return finish(scratch);
  }
  const s = sse;

  await scenario(3, "prompt → deltas, entries, settle, attention", async () => {
    const { events } = await promptAndSettle(agentId, s, "Reply with exactly the word: pong");
    const text = deltasText(events);
    assert(text.length > 0, "no text_delta events");
    assert(
      events.some((e) => e.type === "entries_appended"),
      "no entries_appended",
    );
    assert(
      events.some((e) => e.type === "stats"),
      "no stats event",
    );
    const statusFinished = events.some(
      (e) => e.type === "agent_status" && e.agent.attention === "finished",
    );
    assert(statusFinished, "no agent_status with attention finished");
    const info = (await api("GET", `/api/agents/${agentId}`)).json.agent;
    assert(info.attention === "finished", `attention ${info.attention}`);
    assert(info.isStreaming === false, "isStreaming after settle");
    const ack = await api("POST", `/api/agents/${agentId}/ack`, {});
    assert(ack.status === 204, `ack → ${ack.status}`);
    const after = (await api("GET", `/api/agents/${agentId}`)).json.agent;
    assert(after.attention === "none", `attention after ack ${after.attention}`);
    const snap = (await api("GET", `/api/agents/${agentId}/snapshot`)).json;
    const users = messageEntries(snap.transcript, "user");
    const assistants = messageEntries(snap.transcript, "assistant");
    assert(
      users.some((u) => entryText(u).includes("pong")),
      "user entry missing",
    );
    assert(
      assistants.length > 0 && entryText(assistants.at(-1) as Json) === text,
      "assistant entry ≠ deltas",
    );
    assert(snap.live.streaming === undefined, "live.streaming not cleared");
    assert(snap.live.run.active === false, "run still active");
    assert(snap.live.pendingUser === undefined, "pendingUser not cleared");
    assert(snap.transcript.leafId === snap.transcript.entries.at(-1).id, "leafId ≠ last entry");
    assert(
      snap.stats?.tokens?.total > 0 || snap.stats?.cost > 0,
      `stats: ${JSON.stringify(snap.stats).slice(0, 200)}`,
    );
    await assertTranscriptConsistent(agentId);
    // Resume points: open=<id>:<snapshot seq> starts right after it; a Last-Event-ID cursor
    // the log can't replay from gets resync.
    const tail = new Sse(agentId, snap.seq);
    await api("POST", `/api/agents/${agentId}/ack`, {});
    await rpcOk(agentId, { type: "set_thinking_level", level: "low" });
    await tail.waitFor((e) => e.type === "state", "state after open", 5_000);
    tail.close();
    assert(
      tail.events[0]?.seq === snap.seq + 1,
      `open → first seq ${tail.events[0]?.seq}, want ${snap.seq + 1}`,
    );
    for (const bogus of [snap.seq + 10_000, "abc"]) {
      const r = new Sse(agentId, snap.seq, bogus);
      await r.waitFor(() => true, "first event", 5_000).catch(() => undefined);
      r.close();
      assert(
        r.events[0]?.data.type === "resync",
        `Last-Event-ID ${bogus} → ${r.events[0]?.data.type}`,
      );
    }
    return `text=${JSON.stringify(text)}`;
  });

  await scenario(4, "reconnect with Last-Event-ID mid-stream", async () => {
    const start = (await api("GET", `/api/agents/${agentId}/snapshot`)).json.seq as number;
    const full = new Sse(agentId, start);
    const flaky = new Sse(agentId, start);
    await rpcOk(agentId, {
      type: "prompt",
      message: "Do not use any tools. Count from 1 to 60 as plain text, one number per line.",
    });
    let deltas = 0;
    await flaky.waitFor((e) => textDelta(e) && ++deltas >= 3, "3 deltas on flaky", TURN_TIMEOUT);
    const cutAt = flaky.lastId;
    flaky.close();
    // Hydrate mid-stream like the web client: snapshot, then events since its seq.
    const mid = (await api("GET", `/api/agents/${agentId}/snapshot`)).json;
    const hydrated = new Sse(agentId, mid.seq);
    await flaky.done;
    await sleep(1500);
    assert(cutAt !== undefined, "no id seen");
    // Reconnect like EventSource: the same URL, plus Last-Event-ID.
    const resumed = new Sse(agentId, start, cutAt);
    await full.waitFor(isPi("agent_settled"), "full settle");
    await resumed.waitFor(isPi("agent_settled"), "resumed settle");
    await sleep(200);
    const final = (await api("GET", `/api/agents/${agentId}/snapshot`)).json;
    await hydrated.waitFor(() => (hydrated.lastId ?? 0) >= final.seq, "hydrated catch-up", 5_000);
    full.close();
    resumed.close();
    hydrated.close();
    assert(mid.live.run.active, "mid-stream snapshot has no active run");
    let live = mid.live;
    let caches = {
      agent: mid.agent,
      state: mid.state,
      transcript: mid.transcript,
      stats: mid.stats,
      gitStatus: mid.gitStatus,
    };
    for (const e of hydrated.events) {
      if ((e.seq ?? 0) > final.seq) break;
      live = reduceLive(live, e.data as never);
      caches = applyServerEventToCaches(caches as never, e.data as never) as typeof caches;
    }
    const { seq: _seq, ...want } = final;
    const got = JSON.parse(JSON.stringify({ ...caches, live }));
    for (const key of Object.keys(want)) {
      assert(isDeepStrictEqual(got[key], want[key]), `snapshot + replay ≠ final snapshot (${key})`);
    }
    assert(resumed.data()[0]?.type !== "resync", "got resync");
    const firstResumedId = resumed.events[0]?.seq;
    assert(firstResumedId === cutAt + 1, `resumed at ${firstResumedId}, expected ${cutAt + 1}`);
    const a = deltasText(full.data());
    const b = deltasText([...flaky.data(), ...resumed.data()]);
    assert(a.length > 50 && a === b, `delta text differs (${a.length} vs ${b.length})`);
    const settledId = full.events.find((e) => isPi("agent_settled")(e.data))?.seq as number;
    const upToSettle = (evs: SseEvent[]) =>
      evs.map((e) => e.seq as number).filter((id) => id <= settledId);
    const ids = upToSettle([...flaky.events, ...resumed.events]);
    assert(
      ids.every((id, i) => i === 0 || id === (ids[i - 1] as number) + 1),
      "ids not contiguous",
    );
    const fullIds = upToSettle(full.events);
    assert(JSON.stringify(fullIds) === JSON.stringify(ids), "id sets differ");
    const lines = a.trim().split("\n");
    return `${lines.length} lines, cut after id ${cutAt}`;
  });

  await scenario(5, "tool run: read + edit", async () => {
    const { events } = await promptAndSettle(
      agentId,
      s,
      "Use the read tool on notes.txt, then use the edit tool to add a new last line 'smoke-ok' to it. Then reply 'done'.",
    );
    const starts = events.filter(isPi("tool_execution_start")).map((e) => e.event.toolName);
    assert(starts.includes("read"), `tool starts: ${starts}`);
    const editEnd = events.find(
      (e) => isPi("tool_execution_end")(e) && e.event.toolName === "edit",
    );
    assert(editEnd, `no edit tool_execution_end (tools: ${starts})`);
    assert(
      !editEnd.event.isError,
      `edit failed: ${JSON.stringify(editEnd.event.result).slice(0, 200)}`,
    );
    assert(
      typeof editEnd.event.result?.details?.patch === "string",
      "edit result has no details.patch",
    );
    const file = readFileSync(join(scratch, "notes.txt"), "utf8");
    assert(file.includes("smoke-ok"), `notes.txt: ${JSON.stringify(file)}`);
    const snap = (await api("GET", `/api/agents/${agentId}/snapshot`)).json;
    const toolResults = messageEntries(snap.transcript, "toolResult");
    assert(
      toolResults.some((e) => e.message.toolName === "edit"),
      "no edit toolResult entry",
    );
    assert(
      Object.keys(snap.live.tools).length === 0,
      `live.tools not cleared: ${Object.keys(snap.live.tools)}`,
    );
    await assertTranscriptConsistent(agentId);
    const git = events.filter((e) => e.type === "git_status");
    return `tools=${starts.join(",")}${git.length ? `, git_status dirty=${git.at(-1)?.status?.dirty}` : ", no git_status event"}`;
  });

  await scenario(6, "steer + followUp, clear_queue, abort", async () => {
    const from = s.events.length;
    await rpcOk(agentId, {
      type: "prompt",
      message: "Do not use any tools. Write the numbers from 1 to 300 as plain text, one per line.",
    });
    await s.waitFor(isPi("message_update"), "first message_update", TURN_TIMEOUT, from);
    const busy = await rpc(agentId, { type: "prompt", message: "hi" });
    assert(
      busy.status === 400 && busy.json?.error?.code === "streaming_behavior_required",
      `prompt while streaming → ${busy.status}`,
    );
    await rpcOk(agentId, { type: "steer", message: "smoke steer text" });
    await rpcOk(agentId, { type: "follow_up", message: "smoke follow-up text" });
    await rpcOk(agentId, {
      type: "prompt",
      message: "smoke queued via prompt",
      streamingBehavior: "followUp",
    });
    await s.waitFor(
      (e) =>
        isPi("queue_update")(e) && e.event.followUp?.length === 2 && e.event.steering?.length === 1,
      "queue_update with all three",
      10_000,
      from,
    );
    const snapQ = (await api("GET", `/api/agents/${agentId}/snapshot`)).json;
    assert(
      snapQ.live.queue.steering.length === 1 && snapQ.live.queue.followUp.length === 2,
      `live.queue ${JSON.stringify(snapQ.live.queue)}`,
    );
    assert(snapQ.agent.isStreaming === true, "agent.isStreaming false during run");
    const cleared = await rpcOk(agentId, { type: "clear_queue" });
    assert(
      JSON.stringify(cleared) ===
        JSON.stringify({
          steering: ["smoke steer text"],
          followUp: ["smoke follow-up text", "smoke queued via prompt"],
        }),
      `clear_queue → ${JSON.stringify(cleared)}`,
    );
    await rpcOk(agentId, { type: "abort" });
    await s.waitFor(isPi("agent_settled"), "settle after abort", 30_000, from);
    await sleep(300);
    const snap = (await api("GET", `/api/agents/${agentId}/snapshot`)).json;
    const last = messageEntries(snap.transcript, "assistant").at(-1) as Json;
    assert(last.message.stopReason === "aborted", `last stopReason ${last.message.stopReason}`);
    assert(snap.live.run.active === false && snap.live.streaming === undefined, "live not settled");
    assert(
      snap.live.queue.steering.length === 0 && snap.live.queue.followUp.length === 0,
      "queue not empty",
    );
    assert(
      !s.data(from).some((e) => e.type === "agent_status" && e.agent.attention === "finished"),
      "aborted run set attention",
    );
    const users = messageEntries(snap.transcript, "user").map(entryText);
    assert(
      !users.some((t) => t.startsWith("smoke ")),
      "cleared queue items reached the transcript",
    );
    await assertTranscriptConsistent(agentId);
  });

  await scenario(6.1, "steer delivered mid-tool", async () => {
    const from = s.events.length;
    await rpcOk(agentId, {
      type: "prompt",
      message: "Use the bash tool to run `sleep 2; echo slept`, then reply with one word.",
    });
    await s.waitFor(isPi("tool_execution_start"), "tool start", TURN_TIMEOUT, from);
    await rpcOk(agentId, { type: "steer", message: "Also end your reply with the word steered." });
    await s.waitFor(isPi("agent_settled"), "settle", TURN_TIMEOUT, from);
    await sleep(300);
    const evs = s.data(from);
    assert(
      evs.some(
        (e) =>
          isPi("message_end")(e) &&
          e.event.message.role === "user" &&
          entryText(e.event).includes("steered"),
      ),
      "no user message_end for the steer",
    );
    const snap = await assertTranscriptConsistent(agentId);
    assert(
      messageEntries(snap.transcript, "user").some((u) => entryText(u).includes("steered")),
      "steer not in transcript",
    );
    assert(snap.live.queue.steering.length === 0, "steering queue not empty");
    assert(snap.live.pendingUser === undefined, "pendingUser left");
    await api("POST", `/api/agents/${agentId}/ack`, {});
  });

  await scenario(6.2, "abort mid-tool → no failed attention", async () => {
    const from = s.events.length;
    await rpcOk(agentId, { type: "prompt", message: "Use the bash tool to run `sleep 30`." });
    await s.waitFor(isPi("tool_execution_start"), "tool start", TURN_TIMEOUT, from);
    await sleep(300);
    await rpcOk(agentId, { type: "abort" });
    await s.waitFor(isPi("agent_settled"), "settle", 30_000, from);
    await sleep(300);
    const evs = s.data(from);
    const attention = evs.filter((e) => e.type === "agent_status").map((e) => e.agent.attention);
    assert(
      !attention.includes("failed") && !attention.includes("finished"),
      `attention: ${attention}`,
    );
    const stops = evs
      .filter((e) => isPi("message_end")(e) && e.event.message.role === "assistant")
      .map((e) => `${e.event.message.stopReason}:${e.event.message.errorMessage ?? ""}`);
    const snap = await assertTranscriptConsistent(agentId);
    assert(Object.keys(snap.live.tools).length === 0, "live.tools not empty after abort");
    assert(snap.agent.isStreaming === false, "isStreaming after abort");
    return `stops=${stops.join(" | ")}`;
  });

  await scenario(7, "rpc bash → 202, bash_output, bash_done", async () => {
    const from = s.events.length;
    const r = await rpc(agentId, { type: "bash", command: "ls" });
    assert(
      r.status === 202 && typeof r.json?.data?.id === "string",
      `bash → ${r.status} ${r.text}`,
    );
    const id = r.json.data.id;
    const doneIdx = await s.waitFor(
      (e) => e.type === "bash_done" && e.id === id,
      "bash_done",
      30_000,
      from,
    );
    const out = s
      .data(from)
      .filter((e) => e.type === "bash_output" && e.id === id)
      .map((e) => e.delta)
      .join("");
    assert(out.includes("notes.txt"), `bash_output: ${JSON.stringify(out)}`);
    const done = s.data(doneIdx)[0] as Json;
    assert(
      done.result.exitCode === 0 && done.result.output.includes("README.md"),
      "bash_done result",
    );
    await s.waitFor(
      (e) =>
        e.type === "entries_appended" &&
        e.entries.some(
          (x: Json) => x.message?.role === "bashExecution" && x.message.command === "ls",
        ),
      "bashExecution entry",
      5_000,
      from,
    );
    const r2 = await rpc(agentId, {
      type: "bash",
      command: "echo hidden-$((40+2))",
      excludeFromContext: true,
    });
    assert(r2.status === 202, `bash !! → ${r2.status}`);
    await s.waitFor(
      (e) => e.type === "bash_done" && e.id === r2.json.data.id,
      "bash_done 2",
      30_000,
      from,
    );
    await sleep(200);
    const snap = (await api("GET", `/api/agents/${agentId}/snapshot`)).json;
    const bashEntries = messageEntries(snap.transcript, "bashExecution");
    const hidden = bashEntries.find((e) => e.message.command.startsWith("echo hidden"));
    assert(
      hidden?.message.excludeFromContext === true,
      `excluded entry: ${JSON.stringify(hidden?.message).slice(0, 200)}`,
    );
    assert(hidden.message.output.includes("hidden-42"), "excluded output");
    assert(snap.live.bash[id] === undefined, "committed bash run left in live.bash");
    await assertTranscriptConsistent(agentId);
    const bad = await rpc(agentId, { type: "bash" });
    assert(bad.status === 400, `bash without command → ${bad.status}`);
    const notAllowed = await rpc(agentId, { type: "export_html" });
    assert(notAllowed.json?.error?.code === "command_not_allowed", "export_html allowed");
  });

  await scenario(8, "extension dialogs", async () => {
    const unknown = await api("POST", `/api/agents/${agentId}/ui-responses`, {
      id: "nope",
      cancelled: true,
    });
    assert(
      unknown.status === 404 && unknown.json?.error?.code === "dialog_not_found",
      `unknown dialog → ${unknown.status}`,
    );
    const cmds = (await rpcOk(agentId, { type: "get_commands" })).commands as Json[];
    if (!cmds.some((c) => c.name === "smoke-dialog")) {
      return "SKIP dialog (server not started with scripts/smoke-pi.sh); 404 for unknown id OK";
    }
    const from = s.events.length;
    const prompt = rpc(agentId, { type: "prompt", message: "/smoke-dialog" });
    const reqIdx = await s.waitFor(
      (e) =>
        e.type === "ui_request" &&
        e.request.method === "select" &&
        e.request.title === "smoke pick",
      "select ui_request",
      15_000,
      from,
    );
    const req = (s.data(reqIdx)[0] as Json).request;
    // pi answers a `/command` prompt only after the handler returns (here: after the dialogs).
    const early = await Promise.race([prompt.then(() => true), sleep(300).then(() => false)]);
    assert(!early, "prompt answered before the dialog was");
    await s.waitFor(
      (e) => e.type === "agent_status" && e.agent.attention === "input",
      "attention input",
      5_000,
      from,
    );
    const snap = (await api("GET", `/api/agents/${agentId}/snapshot`)).json;
    assert(
      snap.live.dialogs.some((d: Json) => d.request.id === req.id),
      "dialog not in live state",
    );
    const bad = await api("POST", `/api/agents/${agentId}/ui-responses`, { id: req.id, value: 3 });
    assert(bad.status === 400, `invalid answer → ${bad.status}`);
    const ans = await api("POST", `/api/agents/${agentId}/ui-responses`, {
      id: req.id,
      value: "beta",
    });
    assert(ans.status === 204, `answer → ${ans.status} ${ans.text}`);
    await s.waitFor((e) => e.type === "ui_resolved" && e.id === req.id, "ui_resolved", 5_000, from);
    const again = await api("POST", `/api/agents/${agentId}/ui-responses`, {
      id: req.id,
      value: "beta",
    });
    assert(again.status === 404, `second answer → ${again.status}`);
    const tIdx = await s.waitFor(
      (e) => e.type === "ui_request" && e.request.title === "smoke timeout",
      "timeout select",
      10_000,
      from,
    );
    const treq = (s.data(tIdx)[0] as Json).request;
    assert(treq.timeout === 1500, `timeout field ${treq.timeout}`);
    const snapT = (await api("GET", `/api/agents/${agentId}/snapshot`)).json;
    const dlg = snapT.live.dialogs.find((d: Json) => d.request.id === treq.id);
    assert(dlg?.expiresAt === dlg?.receivedAt + 1500, "expiresAt not set");
    await s.waitFor(
      (e) => e.type === "ui_resolved" && e.id === treq.id,
      "ui_resolved on timeout",
      5_000,
      tIdx,
    );
    await s.waitFor(
      (e) =>
        e.type === "ui_request" &&
        e.request.method === "notify" &&
        String(e.request.message).startsWith("smoke result"),
      "result notify",
      5_000,
      from,
    );
    const note = s.data(from).find((e) => e.type === "ui_request" && e.request.method === "notify");
    assert(
      note?.request.message === 'smoke result {"choice":"beta","timed":null}',
      `notify: ${note?.request.message}`,
    );
    const pr = await prompt;
    assert(pr.status === 200, `prompt /smoke-dialog → ${pr.status} ${pr.text}`);
    const info = (await api("GET", `/api/agents/${agentId}`)).json.agent;
    assert(info.attention === "none", `attention after dialogs ${info.attention}`);
    const snap2 = (await api("GET", `/api/agents/${agentId}/snapshot`)).json;
    assert(snap2.live.dialogs.length === 0, "dialogs left in live state");
    assert(
      snap2.live.notices.some((n: Json) => n.message.startsWith("smoke result")),
      "notice missing",
    );
    await assertTranscriptConsistent(agentId);
  });

  await scenario(9, "get_commands", async () => {
    const data = await rpcOk(agentId, { type: "get_commands" });
    const cmds = data.commands as Json[];
    assert(Array.isArray(cmds) && cmds.length > 0, "no commands");
    assert(!cmds.some((c) => String(c.name).startsWith("pi-code-")), "pi-code-* not hidden");
    const sources = [...new Set(cmds.map((c) => c.source))];
    assert(sources.includes("extension"), `sources: ${sources}`);
    return `${cmds.length} commands, sources=${sources.join(",")}`;
  });

  await scenario(10, "set_session_name; compact → transcript_reset", async () => {
    const from = s.events.length;
    await rpcOk(agentId, { type: "set_session_name", name: "smoke session" });
    await s.waitFor(
      (e) => e.type === "state" && e.state.sessionName === "smoke session",
      "state with name",
      5_000,
      from,
    );
    await s.waitFor(
      (e) =>
        e.type === "entries_appended" &&
        e.entries.some((x: Json) => x.type === "session_info" && x.name === "smoke session"),
      "session_info entry",
      5_000,
      from,
    );
    const info = (await api("GET", `/api/agents/${agentId}`)).json.agent;
    assert(info.sessionName === "smoke session", `agent sessionName ${info.sessionName}`);

    // Manual compaction needs > keepRecentTokens (20k) of context: add ~45 KB bash outputs.
    for (let i = 0; i < 4; i++) {
      const r = await rpc(agentId, {
        type: "bash",
        command: `for i in $(seq 1 700); do echo "filler line $i ${i} lorem ipsum dolor sit amet $i"; done`,
      });
      assert(r.status === 202, `filler bash → ${r.status}`);
      await s.waitFor(
        (e) => e.type === "bash_done" && e.id === r.json.data.id,
        "filler done",
        30_000,
        from,
      );
    }
    await sleep(200);
    const cFrom = s.events.length;
    const res = await rpc(agentId, { type: "compact" });
    assert(res.status === 200, `compact → ${res.status} ${res.text.slice(0, 300)}`);
    const resetIdx = await s.waitFor(
      (e) => e.type === "transcript_reset",
      "transcript_reset",
      60_000,
      cFrom,
    );
    const reset = s.data(resetIdx)[0] as Json;
    assert(
      reset.transcript.entries.some((x: Json) => x.type === "compaction"),
      "no compaction entry",
    );
    assert(reset.state.sessionName === "smoke session", "reset state lost the name");
    assert(s.data(cFrom).some(isPi("compaction_start")), "no compaction_start");
    const snap = (await api("GET", `/api/agents/${agentId}/snapshot`)).json;
    assert(
      snap.transcript.entries.at(-1).type === "compaction" ||
        snap.transcript.entries.some((x: Json) => x.type === "compaction"),
      "snapshot lacks compaction",
    );
    assert(snap.live.run.compaction === undefined, "live.run.compaction not cleared");
    await assertTranscriptConsistent(agentId);
    const after = await promptAndSettle(agentId, s, "Reply with exactly the word: ok");
    assert(
      after.events.some((e) => e.type === "entries_appended"),
      "no entries after compaction",
    );
    await assertTranscriptConsistent(agentId);
    return `tokensBefore=${res.json.data?.tokensBefore}`;
  });

  await scenario(10.5, "fork, clone, new_session, switch_session, session_owned", async () => {
    const snap0 = await assertTranscriptConsistent(agentId);
    const original = snap0.state.sessionFile as string;
    const expectReset = async (command: Json, what: string) => {
      const from = s.events.length;
      const data = await rpcOk(agentId, command);
      const idx = await s.waitFor(
        (e) => e.type === "transcript_reset",
        `${what} reset`,
        10_000,
        from,
      );
      const reset = s.data(idx)[0] as Json;
      const snap = await assertTranscriptConsistent(agentId);
      assert(
        snap.agent.sessionFile === reset.state.sessionFile,
        `${what}: agent.sessionFile stale`,
      );
      assert(
        snap.state.sessionFile === reset.state.sessionFile,
        `${what}: state.sessionFile stale`,
      );
      assert(
        snap.stats?.sessionFile === undefined || snap.stats.sessionFile === reset.state.sessionFile,
        `${what}: stats are for ${snap.stats?.sessionFile}, session is ${reset.state.sessionFile}`,
      );
      return { data, reset, snap };
    };

    const clone = await expectReset({ type: "clone" }, "clone");
    assert(clone.reset.state.sessionFile !== original, "clone kept the session file");
    // Clone first: a fork before the only user message has no assistant reply, and pi can't
    // clone an unsaved session (s0).
    const forkable = (await rpcOk(agentId, { type: "get_fork_messages" })).messages as Json[];
    assert(forkable.length > 0, "no fork messages");
    const target = forkable.at(-1) as Json;
    const fork = await expectReset({ type: "fork", entryId: target.entryId }, "fork");
    assert(
      fork.data.cancelled === false && fork.data.text === target.text,
      `fork → ${JSON.stringify(fork.data)}`,
    );
    const forked = fork.reset.state.sessionFile;
    assert(
      forked && forked !== original && forked !== clone.reset.state.sessionFile,
      "fork kept the session file",
    );
    assert(
      !fork.snap.transcript.entries.some((e: Json) => e.id === target.entryId),
      "fork kept the target entry",
    );

    const fresh = await expectReset({ type: "new_session" }, "new_session");
    assert(
      !fresh.snap.transcript.entries.some((e: Json) => e.type === "message"),
      "new session has messages",
    );

    const back = await expectReset(
      { type: "switch_session", sessionPath: original },
      "switch_session",
    );
    assert(back.reset.state.sessionFile === original, "switch_session didn't switch");
    assert(
      back.snap.transcript.entries.length === snap0.transcript.entries.length,
      `switched-back transcript ${back.snap.transcript.entries.length} ≠ ${snap0.transcript.entries.length}`,
    );

    const other = await api("POST", "/api/agents", { cwd: scratch });
    assert(other.status === 201, `second agent → ${other.status}`);
    const otherId = other.json.agent.id as string;
    try {
      const os = new Sse(otherId, 0);
      await os.waitFor(
        (e) => e.type === "agent_status" && e.agent.status === "ready",
        "B ready",
        60_000,
      );
      os.close();
      const owned = await rpc(otherId, { type: "switch_session", sessionPath: original });
      assert(
        owned.status === 409 && owned.json?.error?.code === "session_owned",
        `session_owned → ${owned.status} ${owned.text}`,
      );
      const again = await api("POST", "/api/agents", { sessionFile: original });
      return `open {sessionFile} → ${again.status} ${again.json?.error?.code ?? ""}`;
    } finally {
      await api("DELETE", `/api/agents/${otherId}`, {});
    }
  });

  await scenario(10.6, "catalog: projects, sessions, fs/dirs", async () => {
    const snap = (await api("GET", `/api/agents/${agentId}/snapshot`)).json;
    const file = snap.agent.sessionFile as string;
    const projects = (await api("GET", "/api/projects")).json.projects as Json[];
    const project = projects.find((p) => p.cwd === scratch);
    assert(project, `scratch not in /api/projects (${projects.length} projects)`);
    assert(project.sessionCount >= 2 && project.isGitRepo === true, JSON.stringify(project));
    const r = await api("GET", `/api/sessions?cwd=${encodeURIComponent(scratch)}`);
    assert(r.status === 200, `sessions → ${r.status}`);
    const sessions = r.json.sessions as Json[];
    assert(
      sessions.every((x) => x.cwd === scratch),
      "cwd filter leaked other projects",
    );
    const mine = sessions.find((x) => x.file === file);
    assert(mine, `agent's session ${file} not listed (${sessions.map((x) => x.file)})`);
    assert(mine.ownedBy === agentId, `ownedBy ${mine.ownedBy}`);
    assert(mine.name === "smoke session", `name ${mine.name}`);
    assert(
      typeof mine.firstMessage === "string" && mine.firstMessage.length <= 200,
      `firstMessage ${mine.firstMessage}`,
    );
    assert(Date.parse(mine.updatedAt) >= Date.parse(mine.createdAt), "updatedAt < createdAt");
    const all = (await api("GET", "/api/sessions")).json.sessions as Json[];
    assert(all.length >= sessions.length, "all sessions < project sessions");
    const tilde = `~/${scratch.slice(homedir().length + 1)}`;
    const dirs = (await api("GET", `/api/fs/dirs?prefix=${encodeURIComponent(tilde.slice(0, -3))}`))
      .json.dirs as Json[];
    const dir = dirs.find((d) => d.path === scratch);
    assert(dir?.isGitRepo === true && dir.hasSessions === true, `fs/dirs: ${JSON.stringify(dirs)}`);
    const outside = await api("GET", "/api/fs/dirs?prefix=/etc/");
    assert(outside.json?.error?.code === "outside_home", `/etc → ${outside.status}`);
    return `${sessions.length} sessions in scratch, ${projects.length} projects`;
  });

  await scenario(10.7, "git status / diff", async () => {
    writeFileSync(join(scratch, "README.md"), "# smoke\n\nchanged by the smoke test\n");
    writeFileSync(join(scratch, "untracked.txt"), "brand new\n");
    writeFileSync(join(scratch, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));
    const status = (await api("GET", `/api/agents/${agentId}/git/status`)).json.status;
    assert(status?.dirty === true && typeof status.branch === "string", JSON.stringify(status));
    const diff = await api("GET", `/api/agents/${agentId}/git/diff`);
    assert(diff.status === 200, `diff → ${diff.status} ${diff.text.slice(0, 200)}`);
    const files = Object.fromEntries((diff.json.files as Json[]).map((f) => [f.path, f]));
    assert(
      files["README.md"]?.status === "modified",
      `README: ${JSON.stringify(files["README.md"])}`,
    );
    assert(files["README.md"].patch.includes("+changed by the smoke test"), "README patch");
    assert(
      files["untracked.txt"]?.status === "untracked" &&
        files["untracked.txt"].patch.includes("+brand new"),
      `untracked: ${JSON.stringify(files["untracked.txt"])}`,
    );
    assert(files["blob.bin"]?.binary === true && files["blob.bin"].patch === undefined, "binary");
    // The pipeline refreshes git status 2 s after a bash command / turn end.
    const from = s.events.length;
    await rpcOk(agentId, { type: "bash", command: "true" });
    await s.waitFor((e) => e.type === "bash_done", "bash_done", 10_000, from);
    await sleep(2500);
    const snap = (await api("GET", `/api/agents/${agentId}/snapshot`)).json;
    assert(snap.gitStatus?.dirty === true, `snapshot gitStatus ${JSON.stringify(snap.gitStatus)}`);
    return `${Object.keys(files).length} files, branch ${status.branch}`;
  });

  await scenario(10.8, "tree navigate (summarize false, then true)", async () => {
    const snap0 = await assertTranscriptConsistent(agentId);
    const byId = new Map((snap0.transcript.entries as Json[]).map((e) => [e.id, e]));
    const branch: Json[] = [];
    for (let id = snap0.transcript.leafId; id; id = byId.get(id)?.parentId) {
      branch.unshift(byId.get(id) as Json);
    }
    const user1 = branch.find((e) => e.type === "message" && e.message.role === "user");
    assert(user1, "no user message on the active branch");
    const assistant1 = branch.find(
      (e) => e.parentId === user1.id && e.type === "message" && e.message.role === "assistant",
    );
    assert(assistant1, "no assistant reply to the first user message");

    const bad = await api("POST", `/api/agents/${agentId}/tree/navigate`, {
      entryId: "nope",
      summarize: false,
    });
    assert(bad.status === 400, `unknown entry → ${bad.status}`);

    let from = s.events.length;
    const a = await api("POST", `/api/agents/${agentId}/tree/navigate`, {
      entryId: user1.id,
      summarize: false,
    });
    assert(a.status === 200 && a.json.cancelled === false, `navigate A → ${a.status} ${a.text}`);
    await s.waitFor((e) => e.type === "transcript_reset", "reset after A", 10_000, from);
    let snap = await assertTranscriptConsistent(agentId);
    assert(
      snap.transcript.leafId === user1.parentId,
      `leaf ${snap.transcript.leafId} ≠ parent of user1`,
    );
    assert(
      snap.live.editorText?.text === entryText(user1),
      `editorText ${snap.live.editorText?.text}`,
    );

    await promptAndSettle(agentId, s, "Reply with exactly the word: branch");
    const leafBefore = (await api("GET", `/api/agents/${agentId}/snapshot`)).json.transcript.leafId;
    from = s.events.length;
    const b = await api("POST", `/api/agents/${agentId}/tree/navigate`, {
      entryId: assistant1.id,
      summarize: true,
      customInstructions: "One short sentence.",
    });
    assert(b.status === 200 && b.json.cancelled === false, `navigate B → ${b.status} ${b.text}`);
    await s.waitFor((e) => e.type === "transcript_reset", "reset after B", 10_000, from);
    snap = await assertTranscriptConsistent(agentId);
    const leaf = (snap.transcript.entries as Json[]).find((e) => e.id === snap.transcript.leafId);
    assert(
      leaf?.type === "branch_summary" &&
        leaf.parentId === assistant1.id &&
        leaf.fromId === leafBefore,
      `leaf after B: ${JSON.stringify(leaf).slice(0, 300)}`,
    );
    return `summary: ${JSON.stringify(String(leaf.summary).slice(0, 80))}`;
  });

  await scenario(10.9, "open {sessionFile}: double-open, resume, kill → restart", async () => {
    const snap = (await api("GET", `/api/agents/${agentId}/snapshot`)).json;
    const again = await api("POST", "/api/agents", { sessionFile: snap.agent.sessionFile });
    assert(
      again.status === 200 && again.json.agent.id === agentId,
      `double-open → ${again.status} ${again.text.slice(0, 200)}`,
    );
    const missing = await api("POST", "/api/agents", {
      sessionFile: join(scratch, "nope.jsonl"),
    });
    assert(missing.json?.error?.code === "session_not_found", `missing → ${missing.status}`);
    const sessions = (await api("GET", `/api/sessions?cwd=${encodeURIComponent(scratch)}`)).json
      .sessions as Json[];
    const free = sessions.find((x) => !x.ownedBy && x.firstMessage);
    assert(free, "no unowned session with messages to resume");
    const before = new Set(piPids());
    const r = await api("POST", "/api/agents", { sessionFile: free.file });
    assert(r.status === 201, `resume → ${r.status} ${r.text.slice(0, 200)}`);
    const bId = r.json.agent.id as string;
    try {
      const bs = new Sse(bId, 0);
      await bs.waitFor(
        (e) => e.type === "agent_status" && e.agent.status === "ready",
        "B ready",
        60_000,
      );
      const b = await assertTranscriptConsistent(bId);
      assert(b.agent.sessionFile === free.file, `B sessionFile ${b.agent.sessionFile}`);
      assert(b.agent.cwd === scratch, `B cwd ${b.agent.cwd}`);
      assert(
        b.transcript.entries.some((e: Json) => e.type === "message"),
        "B has no messages",
      );
      const owned = (await api("GET", `/api/sessions?cwd=${encodeURIComponent(scratch)}`)).json
        .sessions as Json[];
      assert(owned.find((x) => x.file === free.file)?.ownedBy === bId, "ownedBy not B");

      const pids = piPids().filter((p) => !before.has(p));
      assert(pids.length === 1, `B pids: ${pids}`);
      process.kill(pids[0] as number, "SIGKILL");
      await bs.waitFor(
        (e) => e.type === "agent_status" && e.agent.status === "exited",
        "B exited",
        10_000,
      );
      const exited = (await api("GET", `/api/agents/${bId}`)).json.agent;
      assert(
        exited.status === "exited" && Array.isArray(exited.stderrTail),
        JSON.stringify(exited).slice(0, 200),
      );
      const busy = await rpc(bId, { type: "get_state" });
      assert(busy.json?.error?.code === "agent_exited", `rpc on exited → ${busy.status}`);
      const from = bs.events.length;
      const rs = await api("POST", `/api/agents/${bId}/restart`, {});
      assert(
        rs.status === 200 && rs.json.agent.status === "starting",
        `restart → ${rs.status} ${rs.text.slice(0, 200)}`,
      );
      await bs.waitFor(
        (e) => e.type === "agent_status" && e.agent.status === "ready",
        "B ready again",
        60_000,
        from,
      );
      const b2 = await assertTranscriptConsistent(bId);
      assert(b2.agent.sessionFile === free.file, "restart changed the session file");
      assert(
        JSON.stringify(b2.transcript.entries.map((e: Json) => e.id)) ===
          JSON.stringify(b.transcript.entries.map((e: Json) => e.id)),
        "restarted transcript differs",
      );
      bs.close();
      return `resumed ${b.transcript.entries.length} entries, restarted`;
    } finally {
      await api("DELETE", `/api/agents/${bId}`, {});
    }
  });

  let spend = 0;
  if (agentId) {
    const stats = (await api("GET", `/api/agents/${agentId}/snapshot`)).json?.stats;
    spend = stats?.cost ?? 0;
  }

  await scenario(11, "close agent → process gone, agent_closed", async () => {
    const pids = agentPids.length ? agentPids : piPids().filter((p) => !pidsBefore.has(p));
    assert(pids.length > 0, "no pi process found for the agent");
    const del = await api("DELETE", `/api/agents/${agentId}`, {});
    assert(del.status === 204, `DELETE → ${del.status} ${del.text}`);
    await s.waitFor((e) => e.type === "agent_closed", "agent_closed", 5_000);
    await sleep(500);
    const alive = piPids().filter((p) => pids.includes(p));
    assert(alive.length === 0, `pi still running: ${alive}`);
    const get = await api("GET", `/api/agents/${agentId}`);
    assert(get.status === 404, `GET closed agent → ${get.status}`);
    const again = await api("DELETE", `/api/agents/${agentId}`, {});
    assert(again.status === 404, `second DELETE → ${again.status}`);
  });

  s.close();
  if ((await api("GET", `/api/agents/${agentId}`)).status === 200) {
    await api("DELETE", `/api/agents/${agentId}`, {});
  }

  await scenario(12, "project trust: awaiting_trust → POST /trust → saved", async () => {
    const trustFile = join(homedir(), ".pi", "agent", "trust.json");
    const backup = existsSync(trustFile) ? readFileSync(trustFile) : undefined;
    const dir = join(homedir(), "tmp", `pi-code-smoke-trust-${Date.now()}`);
    scratchDirs.push(dir);
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "settings.json"), "{}\n");
    const ids: string[] = [];
    try {
      const r = await api("POST", "/api/agents", { cwd: dir });
      assert(r.status === 201, `open → ${r.status} ${r.text}`);
      const info = r.json.agent;
      ids.push(info.id);
      assert(info.status === "awaiting_trust", `status ${info.status}`);
      assert(info.trustPrompt?.cwd === dir && info.attention === "input", JSON.stringify(info));
      const busy = await rpc(info.id, { type: "get_state" });
      assert(busy.json?.error?.code === "agent_busy", `rpc while awaiting → ${busy.status}`);
      const ts = new Sse(info.id, 0);
      const t = await api("POST", `/api/agents/${info.id}/trust`, { trusted: true });
      assert(
        t.status === 200 && t.json.agent.status === "starting",
        `trust → ${t.status} ${t.text}`,
      );
      await ts.waitFor(
        (e) => e.type === "agent_status" && e.agent.status === "ready",
        "ready",
        60_000,
      );
      ts.close();
      const saved = JSON.parse(readFileSync(trustFile, "utf8"));
      assert(saved[dir] === true, `trust.json has no entry for ${dir}`);
      const again = await api("POST", "/api/agents", { cwd: dir });
      ids.push(again.json.agent.id);
      assert(again.json.agent.status === "starting", `saved decision → ${again.json.agent.status}`);
      return "decision saved by pi; second open spawned directly";
    } finally {
      for (const id of ids) await api("DELETE", `/api/agents/${id}`, {});
      if (backup === undefined) rmSync(trustFile, { force: true });
      else writeFileSync(trustFile, backup);
      const now = existsSync(trustFile) ? readFileSync(trustFile) : undefined;
      assert(
        backup === undefined ? now === undefined : now !== undefined && backup.equals(now),
        "trust.json not restored byte-identically",
      );
    }
  });

  await scenario(13, "push endpoints; curator listener", async () => {
    const key = await api("GET", "/api/push/vapid-key");
    assert(
      key.status === 200 && typeof key.json?.publicKey === "string",
      `vapid-key → ${key.status}`,
    );
    const endpoint = `https://push.invalid/smoke-${Date.now()}`;
    const sub = await api("POST", "/api/push/subscriptions", {
      endpoint,
      expirationTime: null,
      keys: { p256dh: "smoke", auth: "smoke" },
    });
    assert(sub.status === 204, `subscribe → ${sub.status} ${sub.text}`);
    const bad = await api("POST", "/api/push/subscriptions", { endpoint });
    assert(bad.status === 400, `invalid subscription → ${bad.status}`);
    const del = await api("DELETE", "/api/push/subscriptions", { endpoint });
    assert(del.status === 204, `unsubscribe → ${del.status} ${del.text}`);
    // The curator proxy listens on PI_CODE_CURATOR_PORT (default: main port + 1).
    const curatorBase =
      process.env.SMOKE_CURATOR_URL ?? `http://localhost:${Number(new URL(BASE).port || 80) + 1}`;
    const unknown = await fetch(`${curatorBase}/?session=unknown-smoke-token`).catch(() => null);
    if (unknown === null) return `SKIP curator listener not reachable at ${curatorBase}`;
    assert(unknown.status === 404, `unknown curator token → ${unknown.status}`);
    return "vapid key, subscribe/unsubscribe, curator 404";
  });

  console.log(`session cost ≈ $${spend.toFixed(4)}`);
  finish(scratch);
}

/** Extra scratch dirs created by scenarios (removed with their pi sessions by `finish`). */
const scratchDirs: string[] = [];

function finish(scratch: string) {
  if (process.env.SMOKE_KEEP !== "1") {
    for (const dir of [scratch, ...scratchDirs]) {
      rmSync(dir, { recursive: true, force: true });
      // pi's session dir for that cwd: `--<path with / as ->--`.
      const encoded = `--${dir.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`;
      rmSync(join(homedir(), ".pi", "agent", "sessions", encoded), {
        recursive: true,
        force: true,
      });
    }
  }
  const failed = results.filter((r) => r.status === "FAIL");
  console.log(
    `\n${results.filter((r) => r.status === "PASS").length} passed, ${failed.length} failed, ${results.filter((r) => r.status === "SKIP").length} skipped`,
  );
  process.exitCode = failed.length ? 1 : 0;
}

await main();
