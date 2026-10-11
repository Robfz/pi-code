import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInfo, StreamFrame } from "@pi-code/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { SpawnRequest } from "../agents/agent-manager.ts";
import type { ErrorEnvelope } from "../errors.ts";
import { type Harness, type HarnessOptions, startHarness } from "../testing/http-harness.ts";

const MINI_PI = fileURLToPath(new URL("../testing/mini-pi.ts", import.meta.url));

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** Where mini-pi writes new sessions. */
const sessionsDir = (h: Harness) => join(h.agentDir, "sessions", "--shared--");

/**
 * A harness whose agents run mini-pi (real session files; `prompt "crash"` exits). `env` adds to
 * mini-pi's environment.
 */
async function start(
  opts: HarnessOptions = {},
  env: Record<string, string> = {},
): Promise<Harness> {
  let h: Harness | undefined;
  const command = (req: SpawnRequest) => ({
    bin: process.execPath,
    args: [MINI_PI, ...(req.sessionFile ? ["--session", req.sessionFile] : [])],
    env: { ...process.env, MINI_PI_SESSION_DIR: sessionsDir(h as Harness), ...env },
  });
  h = await startHarness({ command, ...opts });
  mkdirSync(sessionsDir(h), { recursive: true });
  harness = h;
  return h;
}

/** Writes a session with a header into `dir` (default: a listed sessions dir). */
function writeSession(h: Harness, id: string, dir = sessionsDir(h)): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id,
    timestamp: new Date().toISOString(),
    cwd: h.project,
  };
  writeFileSync(file, `${JSON.stringify(header)}\n`);
  return file;
}

/** Opens an agent (a new session in the project, or `sessionFile`) and waits until ready. */
async function openReady(h: Harness, body: { sessionFile: string } | { cwd: string }) {
  const res = await h.json<{ agent: AgentInfo }>("POST", "/api/agents", body);
  if (res.status !== 201) throw new Error(`open: ${res.status} ${JSON.stringify(res.body)}`);
  await h.waitForStatus(res.body.agent.id, "ready");
  await h.idle(res.body.agent.id);
  const sessionFile = h.manager.require(res.body.agent.id).sessionFile as string;
  return { id: res.body.agent.id, sessionFile };
}

const del = (h: Harness, body: unknown) =>
  h.json<ErrorEnvelope | undefined>("DELETE", "/api/sessions", body);
const codeOf = (res: { body: unknown }) => (res.body as ErrorEnvelope).error.code;
const messageOf = (res: { body: unknown }) => (res.body as ErrorEnvelope).error.message;

type CatalogFrame = Extract<StreamFrame, { type: "catalog" }>;

describe("DELETE /api/sessions", () => {
  it("trashes a listed session and publishes the catalog without it", async () => {
    const bin = mkdtempSync(join(tmpdir(), "pi-code-trash-"));
    const trashCommand = join(bin, "trash");
    writeFileSync(trashCommand, '#!/bin/sh\nmv "$1" "$1.trashed"\n', { mode: 0o755 });
    try {
      const h = await start({ trashCommand });
      const file = writeSession(h, "doomed");
      const kept = writeSession(h, "kept");
      await h.hub.refreshCatalog();
      const client = h.stream();
      await client.waitFor((f) => f.type === "baseline");

      expect((await del(h, { file })).status).toBe(204);
      expect(existsSync(file)).toBe(false);
      expect(existsSync(`${file}.trashed`)).toBe(true);
      expect(existsSync(kept)).toBe(true);
      const frame = (await client.waitFor((f) => f.type === "catalog")) as CatalogFrame;
      expect(frame.sessions.map((s) => s.id)).toEqual(["kept"]);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("closes a live agent holding the session before deleting it", async () => {
    // Like pi, mini-pi then saves its session as it exits: deleting first would leave the file.
    const h = await start({}, { MINI_PI_SAVE_ON_EXIT: "1" });
    const agent = await openReady(h, { cwd: h.project });
    expect(existsSync(agent.sessionFile)).toBe(true);
    const client = h.stream();
    await client.waitFor((f) => f.type === "baseline");

    expect((await del(h, { file: agent.sessionFile })).status).toBe(204);
    expect(h.manager.get(agent.id)).toBeUndefined();
    expect(existsSync(agent.sessionFile)).toBe(false);
    await client.waitFor((f) => f.type === "agent_closed" && f.agentId === agent.id);
  });

  it("resolves symlinks in the path to a listed or held session", async () => {
    const h = await start();
    const link = join(h.home, "sessions-link");
    symlinkSync(sessionsDir(h), link);
    const file = writeSession(h, "listed");
    const agent = await openReady(h, { cwd: h.project });
    const through = (target: string) => join(link, target.slice(sessionsDir(h).length));

    expect((await del(h, { file: through(file) })).status).toBe(204);
    expect(existsSync(file)).toBe(false);
    expect((await del(h, { file: through(agent.sessionFile) })).status).toBe(204);
    expect(h.manager.get(agent.id)).toBeUndefined();
    expect(existsSync(agent.sessionFile)).toBe(false);
  });

  it("closes an exited agent holding the session", async () => {
    const h = await start();
    const agent = await openReady(h, { cwd: h.project });
    await h.rpc(agent.id, { type: "prompt", message: "crash" });
    await h.waitForStatus(agent.id, "exited");

    expect((await del(h, { file: agent.sessionFile })).status).toBe(204);
    expect(h.manager.get(agent.id)).toBeUndefined();
    expect(existsSync(agent.sessionFile)).toBe(false);
  });

  it("closes an agent whose session file was never written", async () => {
    const h = await start();
    const agent = await openReady(h, { cwd: h.project });
    rmSync(agent.sessionFile);

    expect((await del(h, { file: agent.sessionFile })).status).toBe(204);
    expect(h.manager.get(agent.id)).toBeUndefined();
  });

  it("answers 204 for a missing file", async () => {
    const h = await start();
    expect((await del(h, { file: join(sessionsDir(h), "gone.jsonl") })).status).toBe(204);
    expect((await del(h, { file: join(h.home, "gone.jsonl") })).status).toBe(204);
  });

  it("keeps files the catalog doesn't list", async () => {
    const h = await start();
    const files = [
      writeSession(h, "home", h.home),
      writeSession(h, "nested", join(sessionsDir(h), "subagent")),
      join(sessionsDir(h), "no-header.jsonl"),
    ];
    writeFileSync(files[2] as string, "not a session\n");
    for (const file of files) {
      const res = await del(h, { file });
      expect(res.status, file).toBe(400);
      expect(codeOf(res)).toBe("session_not_listed");
      expect(messageOf(res)).toContain(file);
      expect(existsSync(file)).toBe(true);
    }
  });

  it("stops an agent holding an unlisted file but keeps the file", async () => {
    const h = await start();
    const file = writeSession(h, "outside", h.home);
    const agent = await openReady(h, { sessionFile: file });
    expect(agent.sessionFile).toBe(file);

    const res = await del(h, { file });
    expect(res.status).toBe(400);
    expect(codeOf(res)).toBe("session_not_listed");
    expect(messageOf(res)).toMatch(/stopped.*kept/);
    expect(h.manager.get(agent.id)).toBeUndefined();
    expect(existsSync(file)).toBe(true);
  });

  it("validates the body", async () => {
    const h = await start();
    for (const body of [{}, { file: "" }, { file: 1 }, { file: "sessions/a.jsonl" }, []]) {
      const res = await del(h, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(codeOf(res)).toBe("invalid_body");
    }
    const res = await h.api("DELETE", "/api/sessions");
    expect(res.status).toBe(400);
  });

  it("falls back to unlink when trash fails", async () => {
    const h = await start({ trashCommand: "false" });
    const file = writeSession(h, "s");
    expect((await del(h, { file })).status).toBe(204);
    expect(existsSync(file)).toBe(false);
  });

  it("fails with internal naming an undeletable file", async () => {
    const h = await start({ trashCommand: "false" });
    const file = writeSession(h, "locked");
    chmodSync(sessionsDir(h), 0o555);
    try {
      const res = await del(h, { file });
      expect(res.status).toBe(500);
      expect(codeOf(res)).toBe("internal");
      expect(messageOf(res)).toBe(`could not delete session file: ${file}`);
      expect(existsSync(file)).toBe(true);
    } finally {
      chmodSync(sessionsDir(h), 0o755);
    }
  });

  it("is guarded by Origin", async () => {
    const h = await start();
    const file = writeSession(h, "s");
    const res = await fetch(`${h.base}/api/sessions`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe("forbidden_origin");
    expect(existsSync(file)).toBe(true);
  });
});
