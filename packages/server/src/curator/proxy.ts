import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { CURATOR_PUBLIC_PORT, type CuratorRegistry } from "./registry.ts";

/** Cookie that routes the curator page's token-less requests (POSTs carry it in the body). */
export const CURATOR_COOKIE = "pi_code_curator";

/** Request bodies are buffered (to read a JSON `token`) up to this size. */
const MAX_BODY_BYTES = 1024 * 1024;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface CuratorProxyOptions {
  /** Tailnet hostname (lowercase, no port). */
  hostname: string;
  registry: CuratorRegistry;
  /** Upstream host of the curators. Default `127.0.0.1`. */
  upstreamHost?: string;
}

function send(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function bodyToken(body: Buffer, contentType: string | undefined): string | undefined {
  if (body.length === 0 || !contentType?.toLowerCase().includes("json")) return undefined;
  try {
    const token = (JSON.parse(body.toString("utf8")) as { token?: unknown } | null)?.token;
    return typeof token === "string" ? token : undefined;
  } catch {
    return undefined;
  }
}

function forwardHeaders(headers: IncomingHttpHeaders, upstreamHost: string): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(key) || key === "cookie" || key === "host") continue;
    out[key] = value;
  }
  out.host = upstreamHost;
  return out;
}

/**
 * The curator proxy: a second listener (`127.0.0.1:PI_CODE_CURATOR_PORT`, served by
 * `tailscale serve --https=8443`) that forwards pi-web-access curator pages to their local
 * ports. Requests are routed by curator session token: the `session` query parameter, a JSON
 * body's `token`, or the `pi_code_curator` cookie set when the page is loaded. Responses are
 * streamed as they arrive (SSE included).
 */
export class CuratorProxy {
  readonly server: Server;
  private readonly opts: CuratorProxyOptions;

  constructor(opts: CuratorProxyOptions) {
    this.opts = opts;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        console.error("[curator] proxy error:", e);
        if (!res.headersSent) send(res, 500, "Internal Server Error");
        else res.destroy();
      });
    });
  }

  /** Listens on `host:port` (port 0 picks one); resolves with the bound port. */
  listen(port: number, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve((this.server.address() as AddressInfo).port);
      });
    });
  }

  /** Stops listening and drops open connections (SSE streams never end on their own). */
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private allowedHosts(localPort: number | undefined): Set<string> {
    const { hostname } = this.opts;
    const hosts = new Set([`${hostname}:${CURATOR_PUBLIC_PORT}`]);
    if (localPort !== undefined) {
      hosts.add(`localhost:${localPort}`);
      hosts.add(`127.0.0.1:${localPort}`);
    }
    return hosts;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!this.allowedHosts(req.socket.localPort).has(host)) {
      send(res, 403, `host not allowed: ${host || "(none)"}`);
      return;
    }
    const secure = host === `${this.opts.hostname}:${CURATOR_PUBLIC_PORT}`;
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://curator.invalid");
    } catch {
      send(res, 400, "Bad Request");
      return;
    }

    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    let body: Buffer | undefined;
    if (hasBody) {
      body = await readBody(req);
      if (body === undefined) {
        send(res, 413, "Payload Too Large");
        return;
      }
    }

    const queryToken = url.searchParams.get("session") ?? undefined;
    const cookieToken = cookieValue(req.headers.cookie, CURATOR_COOKIE);
    const candidates = [
      queryToken,
      body && bodyToken(body, req.headers["content-type"]),
      cookieToken,
    ];
    let token: string | undefined;
    let target: ReturnType<CuratorRegistry["lookup"]>;
    for (const candidate of candidates) {
      if (candidate === undefined) continue;
      target = this.opts.registry.lookup(candidate);
      if (target !== undefined) {
        token = candidate;
        break;
      }
    }
    if (target === undefined || token === undefined) {
      send(res, 404, "Unknown or expired curator session");
      return;
    }

    const upstreamHost = this.opts.upstreamHost ?? "127.0.0.1";
    const headers = forwardHeaders(req.headers, `${upstreamHost}:${target.port}`);
    if (body !== undefined) headers["content-length"] = String(body.length);
    // The page's own GET with `?session=` pins the tab's later token-less requests.
    const setCookie =
      method === "GET" && queryToken === token && url.pathname === "/" && cookieToken !== token
        ? `${CURATOR_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`
        : undefined;

    const upstream = httpRequest(
      {
        host: upstreamHost,
        port: target.port,
        method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (up) => {
        const out: OutgoingHttpHeaders = {};
        for (const [key, value] of Object.entries(up.headers)) {
          if (value !== undefined && !HOP_BY_HOP.has(key)) out[key] = value;
        }
        if (setCookie !== undefined) {
          const existing = out["set-cookie"];
          out["set-cookie"] = [
            ...(Array.isArray(existing) ? existing : existing ? [String(existing)] : []),
            setCookie,
          ];
        }
        const streaming = String(up.headers["content-type"] ?? "").includes("text/event-stream");
        if (streaming) out["x-accel-buffering"] = "no";
        res.writeHead(up.statusCode ?? 502, up.statusMessage, out);
        if (streaming) {
          res.flushHeaders();
          res.socket?.setNoDelay(true);
        }
        up.pipe(res);
        up.on("error", () => res.destroy());
      },
    );
    upstream.on("error", (e) => {
      if (!res.headersSent) send(res, 502, `curator unreachable: ${e.message}`);
      else res.destroy();
    });
    // Client went away (e.g. closed the SSE stream): stop the upstream request too.
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.end(body);
  }
}
