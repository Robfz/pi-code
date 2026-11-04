import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInfo, AgentStatus } from "@pi-code/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { SessionCatalog } from "../catalog/sessions.ts";
import type { ErrorEnvelope } from "../errors.ts";
import { StreamHub } from "../live/stream-hub.ts";
import { PrService } from "../pr/pr-service.ts";
import { SidebarStateStore } from "../store/sidebar-state.ts";
import { fakePiCommand, isAlive } from "../testing/stub-process.ts";
import {
  AgentManager,
  type AgentManagerDeps,
  type AgentRecord,
  piCommand,
} from "./agent-manager.ts";

const HOSTNAME = "mac.tail1234.ts.net";
const PORT = 4180;

let root: string;
let home: string;
let project: string;
let manager: AgentManager;
let records: Array<{ agentId: string; record: AgentRecord }>;
let app: ReturnType<typeof createApp>;

function makeManager(command: AgentManagerDeps["command"] = () => fakePiCommand("plain-answer")) {
  manager = new AgentManager({
    home,
    command,
    onRecord: (agent, record) => records.push({ agentId: agent.id, record }),
  });
  return manager;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-mgr-")));
  home = join(root, "home");
  project = join(home, "project");
  mkdirSync(project, { recursive: true });
  records = [];
  makeManager();
  const catalog = new SessionCatalog({ agentDir: join(root, "agent") });
  const sidebar = new SidebarStateStore(join(root, "data"));
  const prService = new PrService({ dataDir: join(root, "data"), agents: () => manager });
  app = createApp({
    hostname: HOSTNAME,
    port: PORT,
    staticDir: root,
    manager,
    catalog,
    hub: new StreamHub({ manager, catalog, sidebar, prs: prService.store }),
    sidebar,
    prService,
    piVersion: async () => "test",
  });
});

afterEach(async () => {
  await manager.closeAll();
  rmSync(root, { recursive: true, force: true });
});

function waitForStatus(id: string, status: AgentStatus): Promise<AgentInfo> {
  const current = manager.get(id)?.info();
  if (current?.status === status) return Promise.resolve(current);
  return new Promise((resolve) => {
    const onAgent = (info: AgentInfo) => {
      if (info.id === id && info.status === status) {
        manager.off("agent", onAgent);
        resolve(info);
      }
    };
    manager.on("agent", onAgent);
  });
}

function api(method: string, path: string, body?: unknown) {
  return app.request(`http://${HOSTNAME}${path}`, {
    method,
    headers:
      method === "GET" ? {} : { origin: `https://${HOSTNAME}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function errorOf(res: Response): Promise<ErrorEnvelope["error"]> {
  return ((await res.json()) as ErrorEnvelope).error;
}

describe("AgentManager + /api/agents (fake pi)", () => {
  it("opens an agent, lists it, closes it, and the child process is gone", async () => {
    const res = await api("POST", "/api/agents", { cwd: project });
    expect(res.status).toBe(201);
    const { agent } = (await res.json()) as { agent: AgentInfo };
    expect(agent).toMatchObject({
      cwd: project,
      status: "starting",
      isStreaming: false,
      attention: "none",
    });
    expect(agent.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Number.isNaN(Date.parse(agent.startedAt))).toBe(false);

    const ready = await waitForStatus(agent.id, "ready");
    expect(typeof ready.sessionId).toBe("string");
    expect(ready.sessionFile).toMatch(/\.jsonl$/);

    const list = await api("GET", "/api/agents");
    expect(list.status).toBe(200);
    expect(((await list.json()) as { agents: AgentInfo[] }).agents).toEqual([ready]);

    const one = await api("GET", `/api/agents/${agent.id}`);
    expect(((await one.json()) as { agent: AgentInfo }).agent).toEqual(ready);

    const pid = manager.get(agent.id)?.host.pid as number;
    expect(isAlive(pid)).toBe(true);

    const del = await api("DELETE", `/api/agents/${agent.id}`);
    expect(del.status).toBe(204);
    expect(isAlive(pid)).toBe(false);
    expect(manager.list()).toEqual([]);

    const gone = await api("GET", `/api/agents/${agent.id}`);
    expect(gone.status).toBe(404);
    expect((await errorOf(gone)).code).toBe("agent_not_found");
    expect((await api("DELETE", `/api/agents/${agent.id}`)).status).toBe(404);

    // The pipeline seam saw the status transitions, in order (session fields are reported
    // while starting, too).
    const transitions = records
      .filter((r) => r.agentId === agent.id && r.record.kind === "status")
      .map((r) => {
        const { status, sessionFile } = (r.record as { agent: AgentInfo }).agent;
        return { status, sessionFile };
      });
    const { sessionFile } = ready;
    expect(transitions).toEqual([
      { status: "starting", sessionFile: undefined },
      { status: "starting", sessionFile },
      { status: "ready", sessionFile },
      { status: "exited", sessionFile },
    ]);
  });

  it("forwards pi records to the record handler", async () => {
    const agent = await manager.open({ cwd: project });
    await waitForStatus(agent.id, "ready");
    const settled = new Promise<void>((r) =>
      agent.host.on("event", (e) => e.type === "agent_settled" && r()),
    );
    await agent.host.send({ type: "prompt", message: "hi" });
    await settled;
    const kinds = records
      .filter((r) => r.record.kind !== "status")
      .map((r) =>
        r.record.kind === "event" ? r.record.event.type : `ui:${String(r.record.kind)}`,
      );
    expect(kinds[0]).toBe("ui:ui_request");
    expect(kinds.at(-1)).toBe("agent_settled");
  });

  it("rejects cwds outside $HOME", async () => {
    const outside = join(root, "elsewhere");
    mkdirSync(outside);
    const link = join(home, "escape");
    symlinkSync(outside, link);
    for (const cwd of [outside, link, root, "/", join(home, "..", "elsewhere")]) {
      const res = await api("POST", "/api/agents", { cwd });
      expect(res.status, cwd).toBe(400);
      expect((await errorOf(res)).code, cwd).toBe("outside_home");
    }
    expect(manager.list()).toEqual([]);
  });

  it("rejects missing, relative and non-directory cwds", async () => {
    for (const cwd of [join(home, "missing"), "project", ""]) {
      const res = await api("POST", "/api/agents", { cwd });
      expect(res.status, cwd).toBe(400);
      expect((await errorOf(res)).code, cwd).toBe("invalid_body");
    }
    expect((await api("POST", "/api/agents", { cwd: 42 })).status).toBe(400);
  });

  it("accepts $HOME itself", async () => {
    const agent = await manager.open({ cwd: home });
    expect(agent.cwd).toBe(home);
  });

  it("keeps a crashed agent listed as exited with its stderr tail", async () => {
    makeManager(() => ({
      bin: process.execPath,
      args: ["-e", "process.stderr.write('fatal: nope\\n', () => process.exit(2))"],
    }));
    const agent = await manager.open({ cwd: project });
    const exited = await waitForStatus(agent.id, "exited");
    expect(exited).toMatchObject({ status: "exited", exitCode: 2, stderrTail: ["fatal: nope"] });
    expect(manager.list()).toEqual([exited]);
    await manager.close(agent.id);
    expect(manager.list()).toEqual([]);
  });

  it("closeAll stops every agent", async () => {
    const a = await manager.open({ cwd: project });
    const b = await manager.open({ cwd: home });
    const pids = [a.host.pid as number, b.host.pid as number];
    await manager.closeAll();
    expect(pids.map(isAlive)).toEqual([false, false]);
    expect(manager.list()).toEqual([]);
  });
});

describe("piCommand", () => {
  it("builds the pi command line", () => {
    const cmd = piCommand("pi", "/ext/index.ts");
    expect(cmd({ cwd: "/x" })).toEqual({
      bin: "pi",
      args: ["--mode", "rpc", "--extension", "/ext/index.ts"],
    });
    expect(cmd({ cwd: "/x", sessionFile: "/s.jsonl" }).args.slice(-2)).toEqual([
      "--session",
      "/s.jsonl",
    ]);
  });
});
