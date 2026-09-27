/** Registrations expire after this long unless the tool reports its curator again. */
export const CURATOR_TTL_MS = 30 * 60 * 1000;

/** Port of the dedicated HTTPS `tailscale serve` entry for the curator proxy. */
export const CURATOR_PUBLIC_PORT = 8443;

export interface CuratorTarget {
  port: number;
  agentId: string;
  toolCallId: string;
  expiresAt: number;
}

/** The pipeline's view of the registry. */
export interface CuratorHook {
  /** Registers a tool's `details.curatorUrl`; returns the proxied URL (undefined if unusable). */
  register(agentId: string, toolCallId: string, curatorUrl: string): string | undefined;
  /** The tool finished: its curator is closed. */
  release(agentId: string, toolCallId: string): void;
  /** The agent's process is gone (exit or close): all its curators are closed. */
  releaseAgent(agentId: string): void;
}

export interface CuratorRegistryOptions {
  /** Tailnet hostname. */
  hostname: string;
  /** The curator proxy listener's local port (used in dev, when the hostname is `localhost`). */
  proxyPort: number;
  ttlMs?: number;
  now?: () => number;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{8,256}$/;

/** Port and token from a pi-web-access curator URL (`http://<host>:<port>/?session=<token>`). */
export function parseCuratorUrl(raw: string): { port: number; token: string } | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") return undefined;
  const port = Number(url.port);
  const token = url.searchParams.get("session");
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (token === null || !TOKEN_RE.test(token)) return undefined;
  return { port, token };
}

/** `details.curatorUrl` of a tool result or partial result, if any. */
export function curatorUrlOf(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const details = (result as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return undefined;
  const url = (details as { curatorUrl?: unknown }).curatorUrl;
  return typeof url === "string" && url !== "" ? url : undefined;
}

/**
 * Curator sessions reachable through the proxy: session token → local curator port.
 * The token is the curator's own secret; knowing it is what grants access, as on the Mac.
 */
export class CuratorRegistry implements CuratorHook {
  private readonly opts: CuratorRegistryOptions;
  private readonly targets = new Map<string, CuratorTarget>();

  constructor(opts: CuratorRegistryOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** The URL the phone opens for a token. */
  publicUrl(token: string): string {
    const q = `/?session=${encodeURIComponent(token)}`;
    return this.opts.hostname === "localhost"
      ? `http://localhost:${this.opts.proxyPort}${q}`
      : `https://${this.opts.hostname}:${CURATOR_PUBLIC_PORT}${q}`;
  }

  register(agentId: string, toolCallId: string, curatorUrl: string): string | undefined {
    const parsed = parseCuratorUrl(curatorUrl);
    if (parsed === undefined) return undefined;
    this.targets.set(parsed.token, {
      port: parsed.port,
      agentId,
      toolCallId,
      expiresAt: this.now() + (this.opts.ttlMs ?? CURATOR_TTL_MS),
    });
    return this.publicUrl(parsed.token);
  }

  /** The live target of a token; expired registrations are dropped. */
  lookup(token: string): CuratorTarget | undefined {
    const target = this.targets.get(token);
    if (target === undefined) return undefined;
    if (target.expiresAt <= this.now()) {
      this.targets.delete(token);
      return undefined;
    }
    return target;
  }

  release(agentId: string, toolCallId: string): void {
    for (const [token, t] of this.targets) {
      if (t.agentId === agentId && t.toolCallId === toolCallId) this.targets.delete(token);
    }
  }

  releaseAgent(agentId: string): void {
    for (const [token, t] of this.targets) {
      if (t.agentId === agentId) this.targets.delete(token);
    }
  }

  get size(): number {
    return this.targets.size;
  }
}
