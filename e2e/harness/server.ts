import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv } from "./git.ts";

const SERVER_DIR = fileURLToPath(new URL("../../packages/server", import.meta.url));
const READY = /listening on http:\/\/127\.0\.0\.1:(\d+)/;
const START_TIMEOUT_MS = 30_000;

/** One real pi-code server with its own `$HOME`, pi agent dir, data dir and fixtures. */
export interface Server {
  /** `http://localhost:<port>`: an allowed Host, and the Origin of the app's requests. */
  url: string;
  /** Where test projects live: inside the server's `$HOME`, where agents' cwds must be. */
  projectsDir: string;
  /** pi's sessions dir, watched by the server's catalog. */
  sessionsDir: string;
  /** Control files of the pi wrapper (`harness/pi-wrapper.ts`), one per project dir. */
  controlDir: string;
  /** Generated fixtures. */
  fixturesDir: string;
  /** JSON request to the server's API, as the app makes it; throws on an error status. */
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

/** The environment without any of the developer's pi-code, pi or git settings. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = gitEnv(process.env);
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_CODE_") || key === "PI_AGENT_DIR") delete env[key];
  }
  return env;
}

/** The run's temp root, made by `global-setup.ts`. */
export function e2eRoot(): string {
  const root = process.env.E2E_ROOT;
  if (!root) throw new Error("E2E_ROOT is not set: run through the e2e Playwright configs");
  return root;
}

/** Spawns the server; resolves once it listens, rejects if it exits first. */
function launch(env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: SERVER_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Startup output, for the error. The pipes are drained for the server's whole life.
    let output: string | undefined = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not start within ${START_TIMEOUT_MS} ms:\n${output}`));
    }, START_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      if (output === undefined) return;
      output += chunk.toString();
      const match = READY.exec(output);
      if (match) {
        output = undefined;
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]) });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (code ${code}) before listening:\n${output}`));
    });
  });
}

/**
 * Starts a server in `dir` (created) on free ports, running the harness's pi wrapper. Parallel
 * workers can race for a port between the probe and the server's bind, so a failed start is
 * retried once with new ports.
 */
export async function startServer(dir: string): Promise<Server> {
  const home = join(dir, "home");
  const agentDir = join(dir, "agent");
  const dataDir = join(dir, "data");
  const paths = {
    projectsDir: join(home, "projects"),
    sessionsDir: join(agentDir, "sessions"),
    controlDir: join(dir, "control"),
    fixturesDir: join(dir, "fixtures"),
  };
  // The sessions dir must exist before boot, or the server doesn't watch it.
  for (const path of [dataDir, ...Object.values(paths)]) mkdirSync(path, { recursive: true });
  const root = e2eRoot();

  let started: { child: ChildProcess; port: number } | undefined;
  for (let attempt = 0; started === undefined; attempt++) {
    const [port, curatorPort] = [await freePort(), await freePort()];
    const env: NodeJS.ProcessEnv = {
      ...cleanEnv(),
      HOME: home,
      // The shims in `bin`: `trash` deletes for real, instead of moving session files to the
      // developer's Trash.
      PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
      NODE_ENV: "test",
      PI_CODE_PORT: String(port),
      PI_CODE_CURATOR_PORT: String(curatorPort),
      PI_CODE_PI_BIN: join(root, "bin", "pi"),
      PI_CODE_DATA_DIR: dataDir,
      PI_AGENT_DIR: agentDir,
      E2E_CONTROL_DIR: paths.controlDir,
    };
    try {
      started = await launch(env);
    } catch (e) {
      if (attempt > 0) throw e;
    }
  }
  const { child, port } = started;
  const url = `http://localhost:${port}`;

  return {
    url,
    ...paths,
    async api<T>(method: string, path: string, body?: unknown): Promise<T> {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { origin: url, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
      }
      return (response.status === 204 ? undefined : await response.json()) as T;
    },
    stop() {
      return new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.once("exit", () => {
          clearTimeout(kill);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
  };
}
