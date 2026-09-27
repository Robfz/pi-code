import type { MiddlewareHandler } from "hono";
import { errorEnvelope } from "../errors.ts";

export interface GuardOptions {
  /** Tailnet hostname (lowercase, no port). */
  hostname: string;
  /** Main listener port. */
  port: number;
}

/** Hosts the server answers to: the tailnet name (via `tailscale serve`) and local access. */
export function allowedHosts({ hostname, port }: GuardOptions): Set<string> {
  return new Set([hostname, `${hostname}:443`, `localhost:${port}`, `127.0.0.1:${port}`]);
}

/** Origins allowed on non-GET requests. */
export function allowedOrigins({ hostname, port }: GuardOptions): Set<string> {
  return new Set([`https://${hostname}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`]);
}

function requestHost(headerHost: string | undefined, url: string): string {
  if (headerHost) return headerHost.toLowerCase();
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Rejects requests whose `Host` isn't allowlisted (DNS rebinding) and, for non-GET requests,
 * whose `Origin` isn't ours (CSRF) or whose body isn't JSON (forces a CORS preflight).
 */
export function requestGuards(opts: GuardOptions): MiddlewareHandler {
  const hosts = allowedHosts(opts);
  const origins = allowedOrigins(opts);
  return async (c, next) => {
    const host = requestHost(c.req.header("host"), c.req.url);
    if (!hosts.has(host)) {
      return c.json(errorEnvelope("forbidden_host", `host not allowed: ${host || "(none)"}`), 403);
    }
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header("origin");
      if (!origin || !origins.has(origin.toLowerCase())) {
        return c.json(
          errorEnvelope("forbidden_origin", `origin not allowed: ${origin ?? "(none)"}`),
          403,
        );
      }
      const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") {
        return c.json(errorEnvelope("invalid_body", "Content-Type must be application/json"), 400);
      }
    }
    await next();
  };
}
