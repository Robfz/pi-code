import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInfo } from "@pi-code/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionCatalog } from "../catalog/sessions.ts";
import { ApiError } from "../errors.ts";
import { type Harness, startHarness } from "../testing/http-harness.ts";
import { AgentManager, type SpawnRequest } from "./agent-manager.ts";
import { startIdleSweep, sweepIdle } from "./idle-sweep.ts";

const MINI_PI = fileURLToPath(new URL("../testing/mini-pi.ts", import.meta.url));
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** The fake clock's "today". mini-pi stamps its own entries in 2026-01, long before. */
const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

let harness: Harness | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await harness?.close();
  harness = undefined;
});

function sessionsDir(h: Harness): string {
  return join(h.agentDir, "sessions", "--project--");
}

/**
 * A harness whose agents run mini-pi. With `viaSymlink`, mini-pi creates new sessions through a
 * symlink to the agent dir, so agents report non-canonical session paths.
 */
async function start(opts: { viaSymlink?: boolean } = {}): Promise<Harness> {
  let piSessionsDir = "";
  const command = (req: SpawnRequest) => ({
    bin: process.execPath,
    args: [MINI_PI, ...(req.sessionFile ? ["--session", req.sessionFile] : [])],
    env: { ...process.env, MINI_PI_SESSION_DIR: piSessionsDir },
  });
  const h = await startHarness({ command });
  mkdirSync(sessionsDir(h), { recursive: true });
  piSessionsDir = sessionsDir(h);
  if (opts.viaSymlink) {
    const link = join(h.root, "agent-link");
    symlinkSync(h.agentDir, link);
    piSessionsDir = join(link, "sessions", "--project--");
  }
  harness = h;
  return h;
}

/** A session file whose last entry is at `updatedAt`. */
function writeSession(h: Harness, name: string, updatedAt: number): string {
  const file = join(sessionsDir(h), `${name}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: name, timestamp: iso(updatedAt - HOUR), cwd: h.project },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: iso(updatedAt),
      message: { role: "user", content: [{ type: "text", text: name }], timestamp: updatedAt },
    },
  ];
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return file;
}

async function openReady(h: Harness, body: Record<string, unknown>): Promise<AgentInfo> {
  const res = await h.json<{ agent: AgentInfo }>("POST", "/api/agents", body);
  if (res.status !== 201) throw new Error(`open: ${res.status} ${JSON.stringify(res.body)}`);
  await h.waitForStatus(res.body.agent.id, "ready");
  await h.idle(res.body.agent.id);
  return res.body.agent;
}

async function crash(h: Harness, id: string): Promise<void> {
  await h.rpc(id, { type: "prompt", message: "crash" });
  await h.waitForStatus(id, "exited");
  await h.idle(id);
}

describe("idle sweep", () => {
  it("closes agents idle for 7 days, sparing streaming, recent and restarted ones", async () => {
    // The clock runs during setup; it is frozen at `NOW` for the exact 7-day boundaries below.
    vi.useFakeTimers({ toFake: ["Date"], now: NOW - 8 * DAY, shouldAdvanceTime: true });
    const h = await start();
    const idle = await openReady(h, { sessionFile: writeSession(h, "idle", NOW - 7 * DAY) });
    const recent = await openReady(h, {
      sessionFile: writeSession(h, "recent", NOW - 7 * DAY + HOUR),
    });
    const streaming = await openReady(h, { sessionFile: writeSession(h, "busy", NOW - 8 * DAY) });
    await h.rpc(streaming.id, { type: "prompt", message: "hang" });
    await vi.waitFor(() => expect(h.manager.require(streaming.id).info().isStreaming).toBe(true));
    const exited = await openReady(h, { cwd: h.project });
    await crash(h, exited.id);
    const restarted = await openReady(h, {
      sessionFile: writeSession(h, "again", NOW - 8 * DAY - HOUR),
    });
    await crash(h, restarted.id);
    await h.hub.refreshCatalog();
    const written = new Set(["recent", "idle", "busy", "again", "today"]);
    const listed = () =>
      h.hub
        .baseline()
        .sessions.map((s) => s.id)
        .filter((id) => written.has(id));
    expect(listed()).toEqual(["recent", "idle", "busy", "again"]);

    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const today = await openReady(h, { sessionFile: writeSession(h, "today", NOW - 8 * DAY) });
    expect((await h.json("POST", `/api/agents/${restarted.id}/restart`, {})).status).toBe(200);
    await h.waitForStatus(restarted.id, "ready");
    expect(h.manager.require(restarted.id).info().startedAt).toBe(iso(NOW));

    const closed: string[] = [];
    h.manager.on("closed", (id) => closed.push(id));
    await sweepIdle({ manager: h.manager, catalog: h.catalog, hub: h.hub });
    expect(closed.sort()).toEqual([idle.id, exited.id].sort());
    expect(
      h.manager
        .list()
        .map((a) => a.id)
        .sort(),
    ).toEqual([recent.id, streaming.id, restarted.id, today.id].sort());
    // Closing keeps the session files: every session is still listed.
    expect(listed().sort()).toEqual([...written].sort());
  });

  it("matches agents to catalog sessions through symlinks", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW - 8 * DAY, shouldAdvanceTime: true });
    const h = await start({ viaSymlink: true });
    const agent = await openReady(h, { cwd: h.project });
    const file = h.manager.require(agent.id).info().sessionFile as string;
    // Its session was written a day before the sweep: the agent isn't idle.
    writeSession(h, file.slice(file.lastIndexOf("/") + 1, -".jsonl".length), NOW - DAY);
    vi.setSystemTime(NOW);
    await sweepIdle({ manager: h.manager, catalog: h.catalog, hub: h.hub });
    expect(h.manager.list().map((a) => a.id)).toEqual([agent.id]);
    // mini-pi reports the path through the symlink; the agent's is the catalog's.
    const [session] = await h.catalog.sessions();
    expect(session?.file).toBe(file);
    expect(session?.ownedBy).toBe(agent.id);
  });

  it("ignores close errors, e.g. an agent closed concurrently", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW - 8 * DAY, shouldAdvanceTime: true });
    const h = await start();
    const a = await openReady(h, { cwd: h.project });
    const b = await openReady(h, { cwd: h.project });
    vi.setSystemTime(NOW);
    const close = h.manager.close.bind(h.manager);
    vi.spyOn(h.manager, "close").mockImplementation(async (id) => {
      if (id === a.id) throw new ApiError("agent_not_found", `no agent ${id}`);
      await close(id);
    });
    await sweepIdle({ manager: h.manager, catalog: h.catalog, hub: h.hub });
    expect(h.manager.list().map((agent) => agent.id)).toEqual([a.id]);
    expect(h.manager.get(b.id)).toBeUndefined();
  });

  it("runs every hour until stopped", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const manager = new AgentManager({
      home: "/",
      command: () => ({ bin: "/nonexistent", args: [] }),
    });
    const catalog = new SessionCatalog({ agentDir: "/nonexistent" });
    const refreshCatalog = vi.fn(async () => {});
    const stop = startIdleSweep({ manager, catalog, hub: { refreshCatalog } });
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(refreshCatalog).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(refreshCatalog).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(refreshCatalog).toHaveBeenCalledTimes(2);
  });
});
