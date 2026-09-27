import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentManager } from "./agents/agent-manager.ts";
import { createApp } from "./app.ts";
import type { ErrorEnvelope } from "./errors.ts";
import { piVersionProbe } from "./pi-version.ts";

const HOSTNAME = "mac.tail1234.ts.net";
const PORT = 4180;
const ORIGIN = `https://${HOSTNAME}`;

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
  const manager = new AgentManager({
    home: dist,
    command: () => ({ bin: "/nonexistent", args: [] }),
  });
  app = createApp({
    hostname: HOSTNAME,
    port: PORT,
    staticDir: dist,
    manager,
    piVersion: async () => "9.9.9",
  });
});

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
});

function get(path: string, host = HOSTNAME) {
  return app.request(`http://${host}${path}`);
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
