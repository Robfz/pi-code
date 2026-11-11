import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DirsResponse, ProjectsResponse, SessionsResponse } from "@pi-code/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentManager } from "../agents/agent-manager.ts";
import { createApp } from "../app.ts";
import { SessionCatalog } from "../catalog/sessions.ts";
import type { ErrorEnvelope } from "../errors.ts";
import { StreamHub } from "../live/stream-hub.ts";
import { PrReviews } from "../pr/pr-reviews.ts";
import { PrService } from "../pr/pr-service.ts";
import { RepoRegistry } from "../store/repo-registry.ts";
import { SidebarStateStore } from "../store/sidebar-state.ts";
import { testGuides } from "../testing/guides.ts";

const HOSTNAME = "mac.tail1234.ts.net";
const TEST_DATA = fileURLToPath(new URL("../../test-data", import.meta.url));

let home: string;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-catalog-routes-")));
  mkdirSync(join(home, "Dev", "proj"), { recursive: true });
  const manager = new AgentManager({ home, command: () => ({ bin: "/nonexistent", args: [] }) });
  const catalog = new SessionCatalog({ agentDir: TEST_DATA, ownerOf: (f) => manager.ownerOf(f) });
  const sidebar = new SidebarStateStore(join(home, "data"));
  const guides = testGuides(join(home, "data"));
  const prService = new PrService({ dataDir: join(home, "data"), agents: () => manager, guides });
  app = createApp({
    hostname: HOSTNAME,
    port: 4180,
    staticDir: home,
    manager,
    catalog,
    hub: new StreamHub({ manager, catalog, sidebar, prs: prService.store, guides }),
    sidebar,
    prService,
    prReviews: new PrReviews({
      manager,
      prs: prService,
      repos: new RepoRegistry(join(home, "data")),
    }),
    piVersion: async () => "test",
  });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

async function get<T>(path: string) {
  const res = await app.request(`http://${HOSTNAME}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

describe("catalog routes", () => {
  it("GET /api/projects", async () => {
    const res = await get<ProjectsResponse>("/api/projects");
    expect(res.status).toBe(200);
    expect(res.body.projects.map((p) => [p.cwd, p.sessionCount])).toEqual([
      ["/home/user/proj", 3],
      ["/home/user/other", 2],
    ]);
  });

  it("GET /api/sessions with and without cwd", async () => {
    const all = await get<SessionsResponse>("/api/sessions");
    expect(all.body.sessions).toHaveLength(5);
    const other = await get<SessionsResponse>(
      `/api/sessions?cwd=${encodeURIComponent("/home/user/other")}`,
    );
    expect(other.body.sessions.map((s) => s.id)).toEqual(["v2-hook", "header-only"]);
  });

  it("GET /api/sessions?q= matches cwd and name, combinable with cwd", async () => {
    const ids = async (query: string) =>
      (await get<SessionsResponse>(`/api/sessions?${query}`)).body.sessions.map((s) => s.id);
    expect(await ids("q=Other")).toEqual(["v2-hook", "header-only"]);
    expect(await ids("q=renamed")).toEqual(["v3-full"]);
    expect(await ids("q=nowhere")).toEqual([]);
    expect(await ids(`q=user&cwd=${encodeURIComponent("/home/user/proj")}`)).toEqual([
      "forked",
      "v3-full",
      "v1-legacy",
    ]);
    expect(await ids("q=")).toHaveLength(5);
  });

  it("GET /api/fs/dirs", async () => {
    const res = await get<DirsResponse>(`/api/fs/dirs?prefix=${encodeURIComponent("~/D")}`);
    expect(res).toEqual({
      status: 200,
      body: { dirs: [{ path: join(home, "Dev"), isGitRepo: false, hasSessions: false }] },
    });
    const outside = await get<ErrorEnvelope>("/api/fs/dirs?prefix=/");
    expect(outside.status).toBe(400);
    expect(outside.body.error.code).toBe("outside_home");
  });
});
