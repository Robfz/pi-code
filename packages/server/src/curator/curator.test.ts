import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerEvent } from "@pi-code/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../testing/http-harness.ts";
import { CURATOR_COOKIE, CuratorProxy } from "./proxy.ts";
import { CuratorRegistry, curatorUrlOf, parseCuratorUrl } from "./registry.ts";

const HOSTNAME = "mac.tail1234.ts.net";
const TOKEN = "3f1c2a9e-7b4d-4c1e-9a55-0d2b8e6f1a77";

interface Seen {
  method: string;
  url: string;
  host: string | undefined;
  cookie: string | undefined;
  body: string;
}

/** A stand-in for the pi-web-access curator server (same routes and token rules). */
class FakeCurator {
  readonly server: Server;
  readonly seen: Seen[] = [];
  port = 0;
  private sse: ServerResponse | undefined;
  sseClosed = false;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  emit(event: string, data: unknown): void {
    this.sse?.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  close(): Promise<void> {
    return new Promise((r) => {
      this.server.close(() => r());
      this.server.closeAllConnections();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    this.seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      host: req.headers.host,
      cookie: req.headers.cookie,
      body,
    });
    const url = new URL(req.url ?? "/", "http://x");
    const token = url.searchParams.get("session");
    if (req.method === "GET" && url.pathname === "/") {
      if (token !== TOKEN) return void res.writeHead(403).end("Invalid session");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return void res.end("<!doctype html><title>Curator</title>");
    }
    if (req.method === "GET" && url.pathname === "/events") {
      if (token !== TOKEN) return void res.writeHead(403).end("Invalid session");
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      this.sse = res;
      this.sseClosed = false;
      res.on("close", () => {
        this.sseClosed = true;
      });
      this.emit("result", { queryIndex: 0 });
      return;
    }
    if (req.method === "POST") {
      let parsed: { token?: string } = {};
      try {
        parsed = JSON.parse(body) as { token?: string };
      } catch {}
      if (url.pathname === "/submit" && parsed.token !== TOKEN) {
        res.writeHead(403, { "Content-Type": "application/json" });
        return void res.end(JSON.stringify({ ok: false, error: "Invalid session" }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return void res.end(JSON.stringify({ ok: true, path: url.pathname, received: parsed }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: url.pathname, query: url.search }));
  }
}

interface RawResponse {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
}

let curator: FakeCurator;
let registry: CuratorRegistry;
let proxy: CuratorProxy;
let proxyPort: number;
let now: number;

beforeEach(async () => {
  curator = new FakeCurator();
  await curator.listen();
  now = 1_000_000;
  registry = new CuratorRegistry({ hostname: HOSTNAME, proxyPort: 4181, now: () => now });
  proxy = new CuratorProxy({ hostname: HOSTNAME, registry });
  proxyPort = await proxy.listen(0);
});

afterEach(async () => {
  await proxy.close();
  await curator.close();
});

/** A request through the proxy with an explicit Host header. */
function raw(
  method: string,
  path: string,
  opts: { host?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method,
        path,
        headers: { host: opts.host ?? `localhost:${proxyPort}`, ...opts.headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

function register(): void {
  registry.register("agent-1", "tool-1", `http://localhost:${curator.port}/?session=${TOKEN}`);
}

describe("registry", () => {
  it("parses curator URLs", () => {
    expect(parseCuratorUrl(`http://localhost:5123/?session=${TOKEN}`)).toEqual({
      port: 5123,
      token: TOKEN,
    });
    expect(parseCuratorUrl(`http://mac.local:5123/?session=${TOKEN}`)?.port).toBe(5123);
    expect(parseCuratorUrl("http://localhost/?session=abcdefgh1234")).toBeUndefined();
    expect(parseCuratorUrl("http://localhost:5123/")).toBeUndefined();
    expect(parseCuratorUrl("http://localhost:5123/?session=a%20b")).toBeUndefined();
    expect(parseCuratorUrl("not a url")).toBeUndefined();
    expect(curatorUrlOf({ content: [], details: { curatorUrl: "http://x:1/?session=y" } })).toBe(
      "http://x:1/?session=y",
    );
    expect(curatorUrlOf({ details: {} })).toBeUndefined();
    expect(curatorUrlOf(undefined)).toBeUndefined();
  });

  it("maps tokens to public URLs, expires them, and releases them", () => {
    const url = registry.register("a", "t", `http://localhost:5123/?session=${TOKEN}`);
    expect(url).toBe(`https://${HOSTNAME}:8443/?session=${TOKEN}`);
    expect(registry.lookup(TOKEN)?.port).toBe(5123);
    now += 30 * 60 * 1000;
    expect(registry.lookup(TOKEN)).toBeUndefined();

    registry.register("a", "t", `http://localhost:5123/?session=${TOKEN}`);
    registry.release("a", "other");
    expect(registry.lookup(TOKEN)).toBeDefined();
    registry.release("a", "t");
    expect(registry.lookup(TOKEN)).toBeUndefined();
    registry.register("a", "t", `http://localhost:5123/?session=${TOKEN}`);
    registry.releaseAgent("a");
    expect(registry.size).toBe(0);

    const dev = new CuratorRegistry({ hostname: "localhost", proxyPort: 4181 });
    expect(dev.register("a", "t", `http://localhost:5123/?session=${TOKEN}`)).toBe(
      `http://localhost:4181/?session=${TOKEN}`,
    );
  });
});

describe("proxy", () => {
  it("serves the page and pins the token in a cookie (Secure over the tailnet)", async () => {
    register();
    const local = await raw("GET", `/?session=${TOKEN}`);
    expect(local.status).toBe(200);
    expect(local.body).toContain("<title>Curator</title>");
    expect(local.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(local.headers["set-cookie"]).toEqual([
      `${CURATOR_COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict`,
    ]);
    expect(curator.seen[0]).toMatchObject({
      method: "GET",
      url: `/?session=${TOKEN}`,
      host: `127.0.0.1:${curator.port}`,
    });

    const remote = await raw("GET", `/?session=${TOKEN}`, { host: `${HOSTNAME}:8443` });
    expect(remote.status).toBe(200);
    expect(remote.headers["set-cookie"]).toEqual([
      `${CURATOR_COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Secure`,
    ]);
    // Already pinned: no new cookie.
    const again = await raw("GET", `/?session=${TOKEN}`, {
      headers: { cookie: `${CURATOR_COOKIE}=${TOKEN}` },
    });
    expect(again.headers["set-cookie"]).toBeUndefined();
  });

  it("forwards POSTs with the token in the JSON body, preserving method, path and body", async () => {
    register();
    const body = JSON.stringify({ token: TOKEN, selected: [0, 2], summary: "ok ✓" });
    const res = await raw("POST", "/submit", {
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      path: "/submit",
      received: JSON.parse(body),
    });
    expect(curator.seen.at(-1)).toMatchObject({ method: "POST", url: "/submit", body });
  });

  it("routes token-less requests by cookie, preserving the query, without leaking the cookie", async () => {
    register();
    const res = await raw("GET", "/state?x=1&y=two", {
      headers: { cookie: `other=1; ${CURATOR_COOKIE}=${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ path: "/state", query: "?x=1&y=two" });
    expect(curator.seen.at(-1)?.cookie).toBeUndefined();

    const post = await raw("POST", "/heartbeat", {
      headers: { "content-type": "application/json", cookie: `${CURATOR_COOKIE}=${TOKEN}` },
      body: "{}",
    });
    expect(post.status).toBe(200);
    expect(JSON.parse(post.body)).toMatchObject({ ok: true, path: "/heartbeat" });
  });

  it("answers 404 for unknown, missing or expired tokens", async () => {
    register();
    expect((await raw("GET", "/?session=unknown-token-123")).status).toBe(404);
    expect((await raw("GET", "/")).status).toBe(404);
    expect(
      (await raw("GET", "/state", { headers: { cookie: `${CURATOR_COOKIE}=nope-nope-nope` } }))
        .status,
    ).toBe(404);
    expect(
      (
        await raw("POST", "/submit", {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "unknown-token-123" }),
        })
      ).status,
    ).toBe(404);
    now += 31 * 60 * 1000;
    expect((await raw("GET", `/?session=${TOKEN}`)).status).toBe(404);
    expect(curator.seen).toEqual([]);
  });

  it("rejects foreign Host headers", async () => {
    register();
    for (const host of ["evil.example", HOSTNAME, `${HOSTNAME}:443`, "localhost:1"]) {
      const res = await raw("GET", `/?session=${TOKEN}`, { host });
      expect(res.status, host).toBe(403);
    }
    expect(curator.seen).toEqual([]);
  });

  it("answers 502 when the curator is gone", async () => {
    register();
    await curator.close();
    expect((await raw("GET", `/?session=${TOKEN}`)).status).toBe(502);
  });

  it("streams SSE without buffering and closes upstream when the client leaves", async () => {
    register();
    const controller = new AbortController();
    const res = await fetch(`http://localhost:${proxyPort}/events?session=${TOKEN}`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let received = "";
    const readUntil = async (needle: string) => {
      while (!received.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${needle}`);
        received += decoder.decode(value, { stream: true });
      }
    };
    // The first event arrives while the upstream response is still open.
    await readUntil('data: {"queryIndex":0}');
    curator.emit("result", { queryIndex: 1 });
    await readUntil('data: {"queryIndex":1}');
    curator.emit("done", {});
    await readUntil("event: done");
    controller.abort();
    await reader.cancel().catch(() => {});
    await expect.poll(() => curator.sseClosed).toBe(true);
  });
});

describe("pipeline", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("publishes `curator` with the proxied URL once, and releases it when the tool ends", async () => {
    h = await startHarness({ curator: true });
    const state = {
      thinkingLevel: "low",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      sessionId: "s1",
      sessionFile: "/tmp/pi-code-test/s1.jsonl",
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    };
    const curatorUrl = `http://localhost:54321/?session=${TOKEN}`;
    const update = (phase: string) => ({
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "web_search",
      args: { query: "x" },
      partialResult: { content: [], details: { phase, curatorUrl } },
    });
    h.fixture = h.writeFixture("curator", [
      { t: 0, dir: "in", line: { id: "q1", type: "get_state" } },
      {
        t: 0,
        dir: "out",
        line: { id: "q1", type: "response", command: "get_state", success: true, data: state },
      },
      { t: 0, dir: "in", line: { id: "p1", type: "prompt", message: "search" } },
      { t: 0, dir: "out", line: { id: "p1", type: "response", command: "prompt", success: true } },
      { t: 0, dir: "out", line: { type: "agent_start" } },
      {
        t: 0,
        dir: "out",
        line: {
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "web_search",
          args: { query: "x" },
        },
      },
      { t: 0, dir: "out", line: update("curating") },
      { t: 0, dir: "out", line: update("generating-summary") },
      { t: 0, dir: "in", line: { id: "a1", type: "abort" } },
      { t: 0, dir: "out", line: { id: "a1", type: "response", command: "abort", success: true } },
      {
        t: 0,
        dir: "out",
        line: {
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "web_search",
          result: { content: [{ type: "text", text: "done" }], details: { curatorUrl } },
          isError: false,
        },
      },
    ]);
    const agent = await h.open();
    const client = h.sse(agent.id, { since: 0 });
    expect((await h.rpc(agent.id, { type: "prompt", message: "search" })).status).toBe(200);
    const event = await client.waitFor((r) => r.event.type === "curator");
    const proxied = `https://${HOSTNAME}:8443/?session=${TOKEN}`;
    expect(event.event).toEqual({ type: "curator", toolCallId: "call-1", url: proxied });
    await h.idle(agent.id);
    expect(h.curators?.lookup(TOKEN)?.port).toBe(54321);
    expect((await h.snapshot(agent.id)).live.curator).toEqual({ "call-1": proxied });

    expect((await h.rpc(agent.id, { type: "abort" })).status).toBe(200);
    await client.waitFor(
      (r) => r.event.type === "pi" && r.event.event.type === "tool_execution_end",
    );
    await h.idle(agent.id);
    expect(client.events.filter((r) => r.event.type === "curator")).toHaveLength(1);
    expect(h.curators?.lookup(TOKEN)).toBeUndefined();
    const types = client.events.map((r) =>
      r.event.type === "pi" ? r.event.event.type : (r.event as ServerEvent).type,
    );
    // The curator event follows the update that carried the URL.
    expect(types.indexOf("curator")).toBe(types.indexOf("tool_execution_update") + 1);
  });
});
