import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentManager } from "./agents/agent-manager.ts";
import { createApp } from "./app.ts";
import { SessionCatalog } from "./catalog/sessions.ts";
import type { ErrorEnvelope } from "./errors.ts";
import { StreamHub } from "./live/stream-hub.ts";
import { piVersionProbe } from "./pi-version.ts";
import { PrReviews } from "./pr/pr-reviews.ts";
import { PrService } from "./pr/pr-service.ts";
import { RepoRegistry } from "./store/repo-registry.ts";
import { SidebarStateStore } from "./store/sidebar-state.ts";
import { testGuides } from "./testing/guides.ts";

const HOSTNAME = "mac.tail1234.ts.net";
const PORT = 4180;
const ORIGIN = `https://${HOSTNAME}`;
const APP_JS = `export const app = "${"x".repeat(2000)}";`;

let dist: string;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), "pi-code-dist-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>pi-code</title>");
  writeFileSync(join(dist, "sw.js"), "self.x = 1;");
  writeFileSync(join(dist, "manifest.webmanifest"), "{}");
  writeFileSync(join(dist, "icon.png"), "png");
  writeFileSync(join(dist, "assets", "index-abc123.js"), "console.log(1);");
  // A file with the precompressed variants the web build writes.
  writeFileSync(join(dist, "assets", "app-def456.js"), APP_JS);
  writeFileSync(join(dist, "assets", "app-def456.js.br"), brotliCompressSync(APP_JS));
  writeFileSync(join(dist, "assets", "app-def456.js.gz"), gzipSync(APP_JS));
  const manager = new AgentManager({
    home: dist,
    command: () => ({ bin: "/nonexistent", args: [] }),
  });
  const catalog = new SessionCatalog({ agentDir: join(dist, "agent") });
  const sidebar = new SidebarStateStore(join(dist, "data"));
  const guides = testGuides(join(dist, "data"));
  const prService = new PrService({ dataDir: join(dist, "data"), agents: () => manager, guides });
  app = createApp({
    hostname: HOSTNAME,
    port: PORT,
    staticDir: dist,
    manager,
    catalog,
    hub: new StreamHub({ manager, catalog, sidebar, prs: prService.store, guides }),
    sidebar,
    prService,
    prReviews: new PrReviews({
      manager,
      prs: prService,
      repos: new RepoRegistry(join(dist, "data")),
    }),
    piVersion: async () => "9.9.9",
  });
});

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
});

function get(path: string, host = HOSTNAME, headers: Record<string, string> = {}) {
  return app.request(`http://${host}${path}`, { headers });
}

/** Reads `body` until the text read so far contains `marker`, leaving the stream open. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before ${marker}`);
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

function post(
  path: string,
  init: { origin?: string; type?: string; body?: string; host?: string },
) {
  const headers: Record<string, string> = {};
  if (init.origin !== undefined) headers.origin = init.origin;
  if (init.type !== undefined) headers["content-type"] = init.type;
  return app.request(`http://${init.host ?? HOSTNAME}${path}`, {
    method: "POST",
    headers,
    body: init.body ?? "{}",
  });
}

async function errorOf(res: Response): Promise<ErrorEnvelope["error"]> {
  return ((await res.json()) as ErrorEnvelope).error;
}

describe("health", () => {
  it("reports pi's version", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, piVersion: "9.9.9" });
  });

  it("probes `pi --version` once and caches it", async () => {
    const probe = piVersionProbe(process.execPath); // `node --version`
    const v = await probe();
    expect(v).toBe(process.version);
    expect(await probe()).toBe(v);
    expect(await piVersionProbe("/nonexistent/pi")()).toBe("unknown");
  });
});

describe("host allowlist", () => {
  it.each([HOSTNAME, `${HOSTNAME}:443`, `localhost:${PORT}`, `127.0.0.1:${PORT}`])(
    "accepts %s",
    async (host) => {
      expect((await get("/api/health", host)).status).toBe(200);
    },
  );

  it.each(["evil.example.com", "localhost", `localhost:${PORT + 1}`, `${HOSTNAME}:8443`])(
    "rejects %s",
    async (host) => {
      const res = await get("/api/health", host);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: { code: "forbidden_host", message: expect.any(String) },
      });
    },
  );

  it("guards the SPA too", async () => {
    expect((await get("/", "evil.example.com")).status).toBe(403);
  });
});

describe("non-GET guards", () => {
  it("rejects a cross-origin POST", async () => {
    const res = await post("/api/agents", {
      origin: "https://evil.example.com",
      type: "application/json",
    });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("forbidden_origin");
  });

  it("rejects a POST without Origin", async () => {
    const res = await post("/api/agents", { type: "application/json" });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("forbidden_origin");
  });

  it("rejects a non-JSON POST", async () => {
    for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded"]) {
      const res = await post("/api/agents", { origin: ORIGIN, ...(type ? { type } : {}) });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("invalid_body");
    }
  });

  it("accepts local origins and JSON with a charset", async () => {
    const res = await post("/api/agents", {
      origin: `http://127.0.0.1:${PORT}`,
      host: `127.0.0.1:${PORT}`,
      type: "application/json; charset=utf-8",
      body: JSON.stringify({ nope: 1 }),
    });
    // Passes the guards; rejected by body validation.
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({ code: "invalid_body", message: expect.any(String) });
  });

  it("renders malformed JSON as invalid_body", async () => {
    const res = await post("/api/agents", {
      origin: ORIGIN,
      type: "application/json",
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid_body");
  });
});

describe("static SPA", () => {
  it("falls back to index.html for client routes, with no-cache", async () => {
    for (const path of ["/", "/agents/abc", "/sessions/x/y?z=1"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toContain("<title>pi-code</title>");
    }
  });

  it("serves hashed assets as immutable", async () => {
    const res = await get("/assets/index-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe("console.log(1);");
  });

  it("serves sw.js and the manifest with no-cache", async () => {
    for (const path of ["/sw.js", "/manifest.webmanifest"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
    expect((await get("/manifest.webmanifest")).headers.get("content-type")).toMatch(/manifest/);
  });

  it("serves other files with a short cache", async () => {
    const res = await get("/icon.png");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("serves files as-is to a client that accepts no encoding", async () => {
    const res = await get("/assets/index-abc123.js");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe("console.log(1);");
  });

  it("answers HEAD with the file's length and no body", async () => {
    const res = await app.request(`http://${HOSTNAME}/assets/index-abc123.js`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String("console.log(1);".length));
    expect(await res.text()).toBe("");
  });

  it("serves the precompressed variant with the highest q, preferring brotli on a tie", async () => {
    const cases: [string, string | null][] = [
      ["gzip, deflate, br, zstd", "br"],
      ["gzip", "gzip"],
      ["br;q=0, gzip;q=0.5", "gzip"],
      ["br;q=0.1, gzip", "gzip"],
      ["BR;Q=0.8, gzip;q=0.9", "gzip"],
      ["gzip;q=0.5, br;q=0.5", "br"],
      ["*", "br"],
      ["*;q=0.5, gzip", "gzip"],
      ["*, br;q=0", "gzip"],
      ["*;q=0", null],
      ["identity", null],
      ["gzip;q=0", null],
      ["br;q=0, gzip;q=0", null],
    ];
    for (const [accept, encoding] of cases) {
      const res = await get("/assets/app-def456.js", HOSTNAME, { "accept-encoding": accept });
      expect(res.status, accept).toBe(200);
      expect(res.headers.get("content-encoding"), accept).toBe(encoding);
      expect(res.headers.get("vary"), accept).toBe("Accept-Encoding");
      expect(res.headers.get("content-type"), accept).toMatch(/javascript/);
      expect(res.headers.get("cache-control"), accept).toBe("public, max-age=31536000, immutable");
      const body = Buffer.from(await res.arrayBuffer());
      const decoded =
        encoding === "br"
          ? brotliDecompressSync(body)
          : encoding === "gzip"
            ? gunzipSync(body)
            : body;
      expect(decoded.toString(), accept).toBe(APP_JS);
    }
  });

  it("answers HEAD with the length of the variant it would send", async () => {
    const res = await app.request(`http://${HOSTNAME}/assets/app-def456.js`, {
      method: "HEAD",
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("content-length")).toBe(String(gzipSync(APP_JS).byteLength));
  });

  it("serves a file without variants as-is to a client accepting compression", async () => {
    const res = await get("/assets/index-abc123.js", HOSTNAME, { "accept-encoding": "gzip, br" });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(await res.text()).toBe("console.log(1);");
  });

  it("404s missing assets instead of serving index.html", async () => {
    expect((await get("/assets/missing-000.js")).status).toBe(404);
  });

  it("does not escape the dist dir", async () => {
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/assets/%2e%2e/%2e%2e/x"]) {
      const res = await get(path);
      const body = await res.text();
      expect(body).not.toContain('"name"');
    }
  });

  it("answers unknown /api routes with a JSON 404", async () => {
    const res = await get("/api/nope");
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("not_found");
  });
});

describe("JSON compression", () => {
  it("gzips JSON responses for a client that accepts it", async () => {
    const res = await get("/api/health", HOSTNAME, { "accept-encoding": "gzip, deflate, br" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    const body = gunzipSync(Buffer.from(await res.arrayBuffer())).toString();
    expect(JSON.parse(body)).toEqual({ ok: true, piVersion: "9.9.9" });
  });

  it("sends JSON as-is to a client that accepts no encoding", async () => {
    const res = await get("/api/health");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual({ ok: true, piVersion: "9.9.9" });
  });
});

describe("live stream", () => {
  it("streams frames as they happen, uncompressed, to a client accepting compression", async () => {
    const controller = new AbortController();
    const res = await app.request(`http://${HOSTNAME}/api/stream`, {
      headers: { "accept-encoding": "gzip, deflate, br" },
      signal: controller.signal,
    });
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("content-encoding")).toBeNull();
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    try {
      expect(await readUntil(reader, '"type":"baseline"')).toMatch(/^retry: \d+\n\n/);
      // A change after the baseline arrives while the stream stays open.
      const patched = await app.request(`http://${HOSTNAME}/api/sidebar`, {
        method: "PATCH",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ collapsed: { [dist]: true } }),
      });
      expect(patched.status).toBe(200);
      expect(await readUntil(reader, '"type":"sidebar"')).toContain(JSON.stringify([dist]));
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  });
});

describe("unknown routes", () => {
  it("answers unknown /api routes with a JSON 404", async () => {
    const res = await get("/api/nope");
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("not_found");
  });
});
