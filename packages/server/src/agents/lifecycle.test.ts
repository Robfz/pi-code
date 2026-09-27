import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInfo, ServerEvent, SessionSummary, Snapshot } from "@pi-code/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ErrorEnvelope } from "../errors.ts";
import { type Harness, type HarnessOptions, startHarness } from "../testing/http-harness.ts";
import type { SpawnRequest } from "./agent-manager.ts";

const MINI_PI = fileURLToPath(new URL("../testing/mini-pi.ts", import.meta.url));

let harness: Harness | undefined;
/** Extra environment for mini-pi processes spawned from now on. */
let extraEnv: Record<string, string> = {};

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  extraEnv = {};
});

function sessionsDir(h: Harness): string {
  return join(h.agentDir, "sessions", "--project--");
}

async function start(opts: HarnessOptions = {}): Promise<Harness> {
  let h: Harness | undefined;
  const command = (req: SpawnRequest) => ({
    bin: process.execPath,
    args: [MINI_PI, ...(req.sessionFile ? ["--session", req.sessionFile] : [])],
    env: { ...process.env, MINI_PI_SESSION_DIR: sessionsDir(h as Harness), ...extraEnv },
  });
  h = await startHarness({ command, ...opts });
  mkdirSync(sessionsDir(h), { recursive: true });
  harness = h;
  return h;
}

type Json = Record<string, unknown>;

/** Writes a session file whose header cwd is `cwd`; returns its path. */
function writeSession(h: Harness, name: string, cwd: string, entries: Json[] = []): string {
  const file = join(sessionsDir(h), `${name}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: `id-${name}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd,
  };
  writeFileSync(file, `${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
  return file;
}

const CONVERSATION: Json[] = [
  {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "first question" }], timestamp: 1 },
  },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2 },
  },
];

async function open(h: Harness, body: Json) {
  return h.json<{ agent: AgentInfo } & Partial<ErrorEnvelope>>("POST", "/api/agents", body);
}

async function openReady(h: Harness, body: Json): Promise<AgentInfo> {
  const res = await open(h, body);
  if (res.status !== 201) throw new Error(`open: ${res.status} ${JSON.stringify(res.body)}`);
  await h.waitForStatus(res.body.agent.id, "ready");
  await h.idle(res.body.agent.id);
  return h.manager.require(res.body.agent.id).info();
}

function stderrOf(h: Harness, id: string): string {
  return h.manager.require(id).host.stderrTail.join("\n");
}

async function prompt(h: Harness, id: string, message: string) {
  const res = await h.rpc(id, { type: "prompt", message });
  expect(res.status).toBe(200);
  // mini-pi emits the whole run right after the response.
  await new Promise((r) => setTimeout(r, 50));
  await h.idle(id);
}

describe("open { sessionFile }", () => {
  it("resumes a session file with --session and the cwd from its header", async () => {
    const h = await start();
    const file = writeSession(h, "resume", h.project, CONVERSATION);
    const res = await open(h, { sessionFile: file });
    expect(res.status).toBe(201);
    expect(res.body.agent).toMatchObject({ cwd: h.project, status: "starting", sessionFile: file });
    const id = res.body.agent.id;
    await h.waitForStatus(id, "ready");
    await h.idle(id);
    expect(stderrOf(h, id)).toContain(JSON.stringify(["--session", file]));
    const snap = await h.snapshot(id);
    expect(snap.transcript.entries.map((e) => e.id)).toEqual(["u1", "a1"]);
    expect(snap.agent.sessionFile).toBe(file);
    expect(snap.agent.sessionId).toBe("id-resume");
  });

  it("returns the existing agent on double-open (also when concurrent)", async () => {
    const h = await start();
    const file = writeSession(h, "double", h.project, CONVERSATION);
    const [a, b] = await Promise.all([
      open(h, { sessionFile: file }),
      open(h, { sessionFile: file }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.agent.id).toBe(b.body.agent.id);
    const again = await open(h, { sessionFile: file });
    expect(again.status).toBe(200);
    expect(again.body.agent.id).toBe(a.body.agent.id);
    expect(h.manager.list()).toHaveLength(1);

    // The catalog reports the owner.
    const sessions = await h.json<{ sessions: SessionSummary[] }>("GET", "/api/sessions");
    expect(sessions.body.sessions.find((s) => s.file === file)?.ownedBy).toBe(a.body.agent.id);
  });

  it("rejects unknown and non-session files, and files outside $HOME", async () => {
    const h = await start();
    const missing = await open(h, { sessionFile: join(sessionsDir(h), "nope.jsonl") });
    expect(missing.status).toBe(404);
    expect(missing.body.error?.code).toBe("session_not_found");

    const garbage = join(sessionsDir(h), "garbage.jsonl");
    writeFileSync(garbage, 'not json\n{"type":"message"}\n');
    const bad = await open(h, { sessionFile: garbage });
    expect(bad.status).toBe(404);
    expect(bad.body.error?.code).toBe("session_not_found");

    const outsideCwd = writeSession(h, "outside-cwd", "/");
    const res = await open(h, { sessionFile: outsideCwd });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("outside_home");

    const elsewhere = join(h.root, "elsewhere.jsonl");
    writeFileSync(elsewhere, `${JSON.stringify({ type: "session", id: "x", cwd: h.project })}\n`);
    const outside = await open(h, { sessionFile: elsewhere });
    expect(outside.status).toBe(400);
    expect(outside.body.error?.code).toBe("outside_home");

    const relative = await open(h, { sessionFile: "x.jsonl" });
    expect(relative.status).toBe(400);
    expect(h.manager.list()).toEqual([]);
  });

  it("moves ownership with fork, and switch_session to an owned file is rejected", async () => {
    const h = await start();
    const file = writeSession(h, "forked", h.project, CONVERSATION);
    const a = await openReady(h, { sessionFile: file });
    const fork = await h.rpc<{ cancelled: boolean }>(a.id, { type: "fork", entryId: "a1" });
    expect(fork.status).toBe(200);
    const forked = h.manager.require(a.id).info().sessionFile as string;
    expect(forked).not.toBe(file);
    expect(h.manager.ownerOf(forked)).toBe(a.id);
    expect(h.manager.ownerOf(file)).toBeUndefined();

    // The original is free again: opening it spawns a second agent.
    const b = await open(h, { sessionFile: file });
    expect(b.status).toBe(201);
    expect(b.body.agent.id).not.toBe(a.id);
    await h.waitForStatus(b.body.agent.id, "ready");
    const owned = await h.rpc(b.body.agent.id, { type: "switch_session", sessionPath: forked });
    expect(owned.status).toBe(409);
    expect(owned.body.error?.code).toBe("session_owned");
  });

  it("clears the previous session's extension statuses on a session change", async () => {
    const h = await start();
    const a = await openReady(h, { cwd: h.project });
    const first = h.manager.require(a.id).info().sessionId as string;
    expect(Object.keys((await h.snapshot(a.id)).live.statuses)).toEqual([`mini:${first}`]);
    expect((await h.rpc(a.id, { type: "new_session" })).status).toBe(200);
    const snap = await h.snapshot(a.id);
    expect(snap.agent.sessionId).not.toBe(first);
    expect(Object.keys(snap.live.statuses)).toEqual([`mini:${snap.agent.sessionId}`]);
  });
});

describe("restart", () => {
  it("keeps a crashed agent as exited with its stderr tail, and restarts into the same session", async () => {
    const h = await start();
    const a = await openReady(h, { cwd: h.project });
    await prompt(h, a.id, "hello");
    const before = await h.snapshot(a.id);
    const file = before.agent.sessionFile as string;
    expect(before.transcript.entries).toHaveLength(2);
    const client = h.sse(a.id, { since: before.seq });

    const notYet = await h.json<ErrorEnvelope>("POST", `/api/agents/${a.id}/restart`, {});
    expect(notYet.status).toBe(409);
    expect(notYet.body.error.code).toBe("agent_busy");

    await h.rpc(a.id, { type: "prompt", message: "crash" });
    await h.waitForStatus(a.id, "exited");
    await h.idle(a.id);
    const exited = h.manager.require(a.id).info();
    expect(exited).toMatchObject({ status: "exited", exitCode: 3, sessionFile: file });
    expect(exited.stderrTail).toContain("fatal: crashed");
    expect(h.manager.ownerOf(file)).toBe(a.id);

    const res = await h.json<{ agent: AgentInfo }>("POST", `/api/agents/${a.id}/restart`, {});
    expect(res.status).toBe(200);
    expect(res.body.agent).toMatchObject({ id: a.id, status: "starting", sessionFile: file });
    await h.waitForStatus(a.id, "ready");
    await h.idle(a.id);
    expect(stderrOf(h, a.id)).toContain(JSON.stringify(["--session", file]));
    const after = await h.snapshot(a.id);
    expect(after.agent.sessionFile).toBe(file);
    expect(after.transcript.entries.map((e) => e.id)).toEqual(
      before.transcript.entries.map((e) => e.id),
    );
    expect(after.agent.stderrTail).toBeUndefined();
    expect(Object.keys(after.live.statuses)).toEqual([`mini:${after.agent.sessionId}`]);

    // Same event stream: exited → starting → ready, seq continuing.
    await client.waitForSeq(after.seq);
    const statuses = client.events
      .filter((r) => r.event.type === "agent_status")
      .map((r) => (r.event as Extract<ServerEvent, { type: "agent_status" }>).agent.status);
    expect(statuses.slice(-3)).toEqual(["exited", "starting", "ready"]);
    await prompt(h, a.id, "again");
    expect((await h.snapshot(a.id)).transcript.entries).toHaveLength(4);
  });

  it("opening the session of an exited agent restarts that agent", async () => {
    const h = await start();
    const file = writeSession(h, "reopen", h.project, CONVERSATION);
    const a = await openReady(h, { sessionFile: file });
    await h.rpc(a.id, { type: "prompt", message: "crash" });
    await h.waitForStatus(a.id, "exited");
    const res = await open(h, { sessionFile: file });
    expect(res.status).toBe(200);
    expect(res.body.agent).toMatchObject({ id: a.id, status: "starting" });
    await h.waitForStatus(a.id, "ready");
  });
});

describe("project trust", () => {
  it("waits for the trust decision, then spawns pi with PI_CODE_TRUST", async () => {
    const h = await start();
    mkdirSync(join(h.project, ".pi"));
    writeFileSync(join(h.project, ".pi", "settings.json"), "{}");
    const res = await open(h, { cwd: h.project });
    expect(res.status).toBe(201);
    const id = res.body.agent.id;
    expect(res.body.agent).toMatchObject({
      status: "awaiting_trust",
      trustPrompt: { cwd: h.project },
      attention: "input",
    });
    expect(h.manager.require(id).hasHost).toBe(false);
    const busy = await h.rpc(id, { type: "get_state" });
    expect(busy.status).toBe(409);
    expect(busy.body.error?.code).toBe("agent_busy");
    const snap: Snapshot = await h.snapshot(id);
    expect(snap.agent.status).toBe("awaiting_trust");

    const bad = await h.json("POST", `/api/agents/${id}/trust`, { trusted: "yes" });
    expect(bad.status).toBe(400);
    const trusted = await h.json<{ agent: AgentInfo }>("POST", `/api/agents/${id}/trust`, {
      trusted: true,
    });
    expect(trusted.status).toBe(200);
    expect(trusted.body.agent.status).toBe("starting");
    expect(trusted.body.agent.trustPrompt).toBeUndefined();
    await h.waitForStatus(id, "ready");
    expect(stderrOf(h, id)).toContain("trust=yes");
    expect(h.manager.require(id).info().attention).toBe("none");

    const twice = await h.json<ErrorEnvelope>("POST", `/api/agents/${id}/trust`, {
      trusted: false,
    });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("agent_busy");
  });

  it("relays a refusal, spawns right away with a saved decision, and closes a waiting agent", async () => {
    const h = await start();
    mkdirSync(join(h.project, ".pi", "extensions"), { recursive: true });
    const a = await open(h, { cwd: h.project });
    expect(a.body.agent.status).toBe("awaiting_trust");
    await h.json("POST", `/api/agents/${a.body.agent.id}/trust`, { trusted: false });
    await h.waitForStatus(a.body.agent.id, "ready");
    expect(stderrOf(h, a.body.agent.id)).toContain("trust=no");

    writeFileSync(join(h.agentDir, "trust.json"), JSON.stringify({ [h.home]: true }));
    const b = await open(h, { cwd: h.project });
    expect(b.body.agent.status).toBe("starting");
    await h.waitForStatus(b.body.agent.id, "ready");
    expect(stderrOf(h, b.body.agent.id)).toContain("trust=-");

    writeFileSync(join(h.agentDir, "trust.json"), "{}");
    const c = await open(h, { cwd: h.project });
    expect(c.body.agent.status).toBe("awaiting_trust");
    expect((await h.api("DELETE", `/api/agents/${c.body.agent.id}`)).status).toBe(204);
    expect(h.manager.get(c.body.agent.id)).toBeUndefined();
  });
});

describe("tree navigation", () => {
  async function conversation(h: Harness) {
    const a = await openReady(h, { cwd: h.project });
    await prompt(h, a.id, "one");
    await prompt(h, a.id, "two");
    const entries = (await h.snapshot(a.id)).transcript.entries;
    expect(entries).toHaveLength(4);
    return { id: a.id, entries };
  }

  it("moves the leaf in place and resyncs", async () => {
    const h = await start();
    const { id, entries } = await conversation(h);
    const [user1, assistant1, user2] = entries.map((e) => e.id) as [string, string, string];
    const seq = (await h.snapshot(id)).seq;
    const client = h.sse(id, { since: seq });

    const nav = await h.json<{ cancelled: boolean }>("POST", `/api/agents/${id}/tree/navigate`, {
      entryId: assistant1,
      summarize: false,
    });
    expect(nav).toEqual({ status: 200, body: { cancelled: false } });
    let snap = await h.snapshot(id);
    expect(snap.transcript.leafId).toBe(assistant1);
    await client.waitFor((r) => r.event.type === "transcript_reset");

    // Navigating to where the leaf already is: nothing moves.
    const same = await h.json("POST", `/api/agents/${id}/tree/navigate`, {
      entryId: assistant1,
      summarize: false,
    });
    expect(same.body).toEqual({ cancelled: true });

    // To a user message, with a summary: leaf = summary under its parent; text → editor.
    const summarized = await h.json("POST", `/api/agents/${id}/tree/navigate`, {
      entryId: user2,
      summarize: true,
      customInstructions: "short",
    });
    expect(summarized.body).toEqual({ cancelled: false });
    snap = await h.snapshot(id);
    const leaf = snap.transcript.entries.find((e) => e.id === snap.transcript.leafId);
    expect(leaf).toMatchObject({ type: "branch_summary", parentId: assistant1 });
    expect(snap.live.editorText?.text).toBe("two");
    expect(user1).toBeDefined();

    // pi-code-* commands stay hidden from get_commands.
    const cmds = await h.rpc<{ commands: { name: string }[] }>(id, { type: "get_commands" });
    expect(cmds.body.data.commands).toEqual([]);
  });

  it("validates the body and the entry, and rejects a busy agent", async () => {
    const h = await start();
    const { id, entries } = await conversation(h);
    const post = (body: Json) =>
      h.json<ErrorEnvelope>("POST", `/api/agents/${id}/tree/navigate`, body);
    expect((await post({ entryId: "x" })).status).toBe(400);
    const unknown = await post({ entryId: "nope", summarize: false });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("invalid_body");

    await h.rpc(id, { type: "prompt", message: "hang" });
    await h.idle(id);
    const busy = await post({ entryId: entries[1]?.id as string, summarize: false });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe("agent_busy");
  });

  it("fails clearly without the pi-code extension, and reports navigation errors", async () => {
    const h = await start();
    extraEnv = { MINI_PI_NO_EXT: "1" };
    const { id, entries } = await conversation(h);
    const res = await h.json<ErrorEnvelope>("POST", `/api/agents/${id}/tree/navigate`, {
      entryId: entries[1]?.id,
      summarize: false,
    });
    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain("pi-code-tree");
    // Nothing reached the model.
    expect((await h.snapshot(id)).transcript.entries).toHaveLength(4);

    extraEnv = { MINI_PI_TREE_FAIL: "1" };
    const other = await conversation(h);
    const failed = await h.json<ErrorEnvelope>("POST", `/api/agents/${other.id}/tree/navigate`, {
      entryId: other.entries[1]?.id,
      summarize: false,
    });
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe("pi_error");
  });
});

describe("git status in the pipeline", () => {
  it("is in the snapshot and refreshed after turn_end", async () => {
    const h = await start({ pipeline: { gitDebounceMs: 30 } });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: h.project });
    git("init", "-q", "-b", "main");
    writeFileSync(join(h.project, "a.txt"), "one\n");
    git("add", ".");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");

    const a = await openReady(h, { cwd: h.project });
    expect((await h.snapshot(a.id)).gitStatus).toEqual({ branch: "main", dirty: false });
    const status = await h.json("GET", `/api/agents/${a.id}/git/status`);
    expect(status.body).toEqual({ status: { branch: "main", dirty: false } });

    const client = h.sse(a.id, { since: (await h.snapshot(a.id)).seq });
    writeFileSync(join(h.project, "a.txt"), "two\n");
    await prompt(h, a.id, "edit");
    const event = await client.waitFor((r) => r.event.type === "git_status", 3_000);
    expect(event.event).toEqual({ type: "git_status", status: { branch: "main", dirty: true } });
    expect((await h.snapshot(a.id)).gitStatus).toEqual({ branch: "main", dirty: true });
  });
});
