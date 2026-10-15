/**
 * The real entry point (`src/main.ts` under tsx's loader) with two fake-pi agents mid-run:
 * SIGINT / SIGTERM must close both listeners, stop every pi process, and exit 0.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInfo } from "@pi-code/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_PI_PATH, fixturePath } from "../../../test/fake-pi.ts";
import { isAlive } from "./testing/stub-process.ts";

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// tsx's loader in the server's own process, not the `tsx` CLI: the CLI relays a signal sent to it
// alone and SIGKILLs its child unless the child acknowledges within 30 ms, which a loaded machine
// misses (exit 130 / 143, pi processes left behind).
const TSX_LOADER = import.meta.resolve("tsx");
const MAIN = join(SERVER_DIR, "src", "main.ts");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

let root: string | undefined;
let server: ChildProcess | undefined;

afterEach(() => {
  if (server?.exitCode === null) server.kill("SIGKILL");
  server = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function run(signal: NodeJS.Signals, speed: number): Promise<void> {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-shutdown-")));
  const home = join(root, "home");
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, "agent", "sessions"), { recursive: true });
  const pids = join(root, "pids");
  const piBin = join(root, "pi");
  writeFileSync(
    piBin,
    `#!/bin/sh\n[ "$1" = "--version" ] && { echo 0.0.0-fake; exit 0; }\necho $$ >> "${pids}"\nexec "${process.execPath}" "${FAKE_PI_PATH}" "${fixturePath("plain-answer")}" --speed=${speed}\n`,
  );
  chmodSync(piBin, 0o755);
  const port = await freePort();
  const curatorPort = await freePort();

  let output = "";
  server = spawn(process.execPath, ["--import", TSX_LOADER, MAIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      NODE_ENV: "test",
      PI_CODE_HOSTNAME: "",
      PI_CODE_PORT: String(port),
      PI_CODE_CURATOR_PORT: String(curatorPort),
      PI_CODE_PI_BIN: piBin,
      PI_CODE_DATA_DIR: join(root, "data"),
      PI_AGENT_DIR: join(root, "agent"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (d) => {
    output += String(d);
  });
  server.stderr?.on("data", (d) => {
    output += String(d);
  });
  const exited = new Promise<number | null>((resolve) => server?.once("exit", (c) => resolve(c)));

  const base = `http://localhost:${port}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: method === "GET" ? {} : { origin: base, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  await waitFor(async () => ((await api("GET", "/api/health")).status === 200 ? true : undefined));
  // Both listeners are up; the SPA is served from packages/web/dist even from the repo root.
  expect((await fetch(`http://localhost:${curatorPort}/?session=unknown-token`)).status).toBe(404);
  if (existsSync(join(REPO_ROOT, "packages", "web", "dist", "index.html"))) {
    const spa = await fetch(`${base}/agents/x`);
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toContain("text/html");
  }

  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const res = await api("POST", "/api/agents", { cwd: project });
    expect(res.status, output).toBe(201);
    ids.push((res.body.agent as AgentInfo).id);
  }
  for (const id of ids) {
    await waitFor(async () => {
      const res = await api("GET", `/api/agents/${id}`);
      return (res.body.agent as AgentInfo).status === "ready" ? true : undefined;
    });
    expect(
      (await api("POST", `/api/agents/${id}/rpc`, { type: "prompt", message: "hi" })).status,
    ).toBe(200);
  }
  if (speed > 0) {
    // Mid-run: the fake pi sleeps until its next recorded line and ignores the closed stdin
    // meanwhile, so this also covers the SIGTERM escalation.
    const running = await api("GET", "/api/agents");
    expect((running.body.agents as AgentInfo[]).every((a) => a.isStreaming)).toBe(true);
  }
  const piPids = readFileSync(pids, "utf8").trim().split("\n").map(Number);
  expect(piPids).toHaveLength(2);
  expect(piPids.every(isAlive)).toBe(true);

  server.kill(signal);
  expect(await exited, output).toBe(0);
  expect(piPids.filter(isAlive)).toEqual([]);
  await expect(fetch(`${base}/api/health`)).rejects.toThrow();
  await expect(fetch(`http://localhost:${curatorPort}/`)).rejects.toThrow();
}

describe("graceful shutdown", () => {
  it("SIGINT with two agents mid-run leaves no pi processes behind", async () => {
    await run("SIGINT", 1);
  }, 30_000);

  it("SIGTERM with two idle agents does the same", async () => {
    await run("SIGTERM", 0);
  }, 30_000);
});
