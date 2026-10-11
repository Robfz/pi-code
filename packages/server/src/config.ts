import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  /** Main listener port (`127.0.0.1` only). */
  port: number;
  /** Curator proxy listener port (`127.0.0.1` only). */
  curatorPort: number;
  /** Tailnet hostname; used for the Host allowlist and origin checks. */
  hostname: string;
  /** pi executable. */
  piBin: string;
  /** pi-code's own data (VAPID keys, push subscriptions). */
  dataDir: string;
  /** pi's agent dir (sessions, trust.json); written only to delete session files. */
  agentDir: string;
  /** `$HOME`; agents' cwds must resolve inside it. */
  home: string;
  /** Built SPA (`packages/web/dist`). */
  staticDir: string;
  /** The pi-code pi extension, passed to pi with `--extension`. */
  extensionPath: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const DEV_ENVS = new Set(["development", "test"]);

function parsePort(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(`${key} must be a port number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/**
 * Reads the configuration from the environment. `PI_CODE_HOSTNAME` is required unless
 * `NODE_ENV` is `development` or `test`, where it defaults to `localhost`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME || homedir();
  const hostnameRaw = env.PI_CODE_HOSTNAME?.trim();
  let hostname: string;
  if (hostnameRaw) {
    hostname = hostnameRaw.toLowerCase().replace(/\.$/, "");
    if (!/^[a-z0-9.-]+$/.test(hostname)) {
      throw new ConfigError(
        `PI_CODE_HOSTNAME must be a bare hostname (no scheme or port), got ${JSON.stringify(hostnameRaw)}`,
      );
    }
  } else if (DEV_ENVS.has(env.NODE_ENV ?? "")) {
    hostname = "localhost";
  } else {
    throw new ConfigError(
      "PI_CODE_HOSTNAME is required (the tailnet hostname, e.g. mac.tail1234.ts.net)",
    );
  }

  return {
    port: parsePort(env, "PI_CODE_PORT", 4180),
    curatorPort: parsePort(env, "PI_CODE_CURATOR_PORT", 4181),
    hostname,
    piBin: env.PI_CODE_PI_BIN || "pi",
    dataDir: expandHome(env.PI_CODE_DATA_DIR || "~/.config/pi-code", home),
    agentDir: expandHome(env.PI_AGENT_DIR || "~/.pi/agent", home),
    home,
    staticDir: fileURLToPath(new URL("../../web/dist", import.meta.url)),
    extensionPath: fileURLToPath(new URL("../../pi-extension/src/index.ts", import.meta.url)),
  };
}
