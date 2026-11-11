import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrGuide, StreamFrame } from "@pi-code/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../agents/agent-manager.ts";
import { SessionCatalog } from "../catalog/sessions.ts";
import { type GuideService, guideInputKey } from "../pr/guide-service.ts";
import { PRS_FILE, PrStore } from "../store/pr-store.ts";
import { SidebarStateStore } from "../store/sidebar-state.ts";
import { testGuides } from "../testing/guides.ts";
import { git, makeLayoutRepo } from "../testing/layout-repo.ts";
import { StreamHub } from "./stream-hub.ts";

const TEST_DATA = fileURLToPath(new URL("../../test-data", import.meta.url));
const proj = (name: string) => join(TEST_DATA, "sessions", "--home-user-proj--", name);

let dataRoot: string;

/** A sidebar state store in the test's data dir. */
function sidebarStore(): SidebarStateStore {
  return new SidebarStateStore(join(dataRoot, "data"));
}

/** PR guides in the test's data dir. */
function guides(): GuideService {
  return testGuides(join(dataRoot, "data"));
}

/** A PR store in the test's data dir. */
function prStore(): PrStore {
  return new PrStore(join(dataRoot, "data"));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  dataRoot = mkdtempSync(join(tmpdir(), "pi-code-hub-data-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("StreamHub baseline", () => {
  it("holds every session, most recently prompted first, without ownedBy or updatedAt", async () => {
    const manager = new AgentManager({
      home: TEST_DATA,
      command: () => ({ bin: "/nonexistent", args: [] }),
    });
    // Every session is owned, so `ownedBy` would show up if it weren't stripped.
    const catalog = new SessionCatalog({ agentDir: TEST_DATA, ownerOf: () => "agent-1" });
    const hub = new StreamHub({
      manager,
      catalog,
      sidebar: sidebarStore(),
      prs: prStore(),
      guides: guides(),
    });
    await hub.ready;
    const baseline = hub.baseline();
    expect(baseline.sessions.map((s) => s.id)).toEqual([
      "forked",
      "v3-full",
      "v2-hook",
      "v1-legacy",
      "header-only",
    ]);
    expect(baseline.sessions[0]).toEqual({
      file: proj("2026-01-02T09-00-00-000Z_forked.jsonl"),
      id: "forked",
      cwd: "/home/user/proj",
      firstMessage: "Only a question, never answered",
      createdAt: "2026-01-02T09:00:00.000Z",
      lastPromptAt: "2026-01-02T09:00:01.000Z",
      parentSession: "/sessions/--home-user-proj--/2026-01-01T10-00-00-000Z_v3-full.jsonl",
      missing: true,
    });
    expect(baseline.sessions.some((s) => "ownedBy" in s || "updatedAt" in s)).toBe(false);
    expect(baseline).toMatchObject({
      agents: [],
      branches: {},
      sidebar: { pinned: [], collapsed: [], mains: {} },
      prs: {},
    });
    hub.close();
  });

  it("carries the stored PR attachments as clients see them", async () => {
    const file = proj("2026-01-01T10-00-00-000Z_v3-full.jsonl");
    const view = {
      repo: "octo/repo",
      number: 7,
      title: "PR 7",
      url: "https://github.com/octo/repo/pull/7",
      state: "open",
      baseRefName: "main",
      headRefName: "feature",
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
      remoteHeadSha: "d".repeat(40),
    };
    mkdirSync(join(dataRoot, "data"));
    writeFileSync(
      join(dataRoot, "data", PRS_FILE),
      JSON.stringify({
        [file]: {
          ...view,
          gitDir: join(dataRoot, "missing", ".git"),
          commentsSince: "2026-01-02T00:00:00Z",
          reportedInline: [1],
          previousHeadSha: "a".repeat(40),
          folder: "sub/",
        },
      }),
    );
    const manager = new AgentManager({
      home: TEST_DATA,
      command: () => ({ bin: "/nonexistent", args: [] }),
    });
    const catalog = new SessionCatalog({ agentDir: TEST_DATA });
    const hub = new StreamHub({
      manager,
      catalog,
      sidebar: sidebarStore(),
      prs: prStore(),
      guides: guides(),
    });
    await hub.ready;
    expect(hub.baseline().prs).toEqual({ [file]: view });
    hub.close();
  });
});

describe("StreamHub PR guides", () => {
  it("broadcasts each guide state change by key, a key without a guide as failed", async () => {
    const manager = new AgentManager({
      home: TEST_DATA,
      command: () => ({ bin: "/nonexistent", args: [] }),
    });
    let finish: (guide: PrGuide) => void = () => {};
    const service = testGuides(
      join(dataRoot, "data"),
      () => new Promise<PrGuide>((resolve) => (finish = resolve)),
    );
    const hub = new StreamHub({
      manager,
      catalog: new SessionCatalog({ agentDir: TEST_DATA }),
      sidebar: sidebarStore(),
      prs: prStore(),
      guides: service,
    });
    await hub.ready;
    const frames: StreamFrame[] = [];
    hub.subscribe((f) => frames.push(f));
    const input = {
      cwd: dataRoot,
      folder: "",
      pr: { repo: "o/r", number: 1, title: "t", body: "" },
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    };
    const key = guideInputKey(input);
    const done = service.ensure(input);
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    finish({
      version: 1,
      repo: "o/r",
      number: 1,
      baseSha: "a",
      headSha: "b",
      sections: [],
      other: [],
    });
    await done;
    void service.regenerate(input);
    await vi.waitFor(() => expect(frames).toHaveLength(3));
    service.cancel(key);
    await vi.waitFor(() => expect(frames).toHaveLength(4));
    expect(frames).toEqual([
      { type: "guide", key, state: "generating" },
      { type: "guide", key, state: "ready" },
      { type: "guide", key, state: "generating" },
      { type: "guide", key, state: "ready" },
    ]);
    await service.prune([]);
    void service.regenerate(input);
    await vi.waitFor(() => expect(frames).toHaveLength(5));
    service.cancel(key);
    await vi.waitFor(() => expect(frames).toHaveLength(6));
    expect(frames.at(-1)).toEqual({ type: "guide", key, state: "failed" });
    hub.close();
  });
});

describe("StreamHub catalog refresh", () => {
  let agentDir: string;
  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-code-hub-"));
    mkdirSync(join(agentDir, "sessions", "--p--"), { recursive: true });
  });
  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  function writeSession(id: string, createdAt: string, cwd = "/p"): void {
    const header = { type: "session", version: 3, id, timestamp: createdAt, cwd };
    writeFileSync(
      join(agentDir, "sessions", "--p--", `${id}.jsonl`),
      `${JSON.stringify(header)}\n`,
    );
  }

  function append(id: string, at: string, role: "user" | "assistant"): void {
    const entry = { type: "message", timestamp: at, message: { role, content: "go" } };
    appendFileSync(
      join(agentDir, "sessions", "--p--", `${id}.jsonl`),
      `${JSON.stringify(entry)}\n`,
    );
  }

  const prompt = (id: string, at: string) => append(id, at, "user");

  it("broadcasts catalog only when the list changes, old sessions included", async () => {
    vi.setSystemTime("2026-01-10T00:00:00.000Z");
    writeSession("a", "2026-01-09T00:00:00.000Z");
    const manager = new AgentManager({
      home: agentDir,
      command: () => ({ bin: "/nonexistent", args: [] }),
    });
    const hub = new StreamHub({
      manager,
      catalog: new SessionCatalog({ agentDir }),
      sidebar: sidebarStore(),
      prs: prStore(),
      guides: guides(),
    });
    await hub.ready;
    const frames: StreamFrame[] = [];
    hub.subscribe((f) => frames.push(f));
    expect(hub.baseline().sessions.map((s) => s.id)).toEqual(["a"]);

    await hub.refreshCatalog();
    expect(frames).toEqual([]);

    writeSession("b", "2026-01-09T12:00:00.000Z");
    writeSession("old", "2025-01-01T00:00:00.000Z");
    await hub.refreshCatalog();
    expect(frames.map((f) => f.type === "catalog" && f.sessions.map((s) => s.id))).toEqual([
      ["b", "a", "old"],
    ]);

    // A prompt moves the oldest session to the top.
    prompt("old", "2026-01-09T20:00:00.000Z");
    await hub.refreshCatalog();
    expect(hub.baseline().sessions.map((s) => s.id)).toEqual(["old", "b", "a"]);
    expect(frames).toHaveLength(2);
    hub.close();
  });

  it("broadcasts no catalog for agent output, only for a new prompt", async () => {
    vi.setSystemTime("2026-01-10T00:00:00.000Z");
    writeSession("a", "2026-01-09T00:00:00.000Z");
    prompt("a", "2026-01-09T00:00:01.000Z");
    const manager = new AgentManager({
      home: agentDir,
      command: () => ({ bin: "/nonexistent", args: [] }),
    });
    const hub = new StreamHub({
      manager,
      catalog: new SessionCatalog({ agentDir }),
      sidebar: sidebarStore(),
      prs: prStore(),
      guides: guides(),
    });
    await hub.ready;
    const frames: StreamFrame[] = [];
    hub.subscribe((f) => frames.push(f));

    // Moves the session's last entry time, nothing else.
    append("a", "2026-01-09T00:00:05.000Z", "assistant");
    await hub.refreshCatalog();
    expect(frames).toEqual([]);

    prompt("a", "2026-01-09T00:00:09.000Z");
    await hub.refreshCatalog();
    expect(frames).toEqual([
      {
        type: "catalog",
        sessions: [expect.objectContaining({ id: "a", lastPromptAt: "2026-01-09T00:00:09.000Z" })],
      },
    ]);
    hub.close();
  });

  it("runs one rescan at a time; calls made meanwhile share one follow-up", async () => {
    vi.setSystemTime("2026-01-10T00:00:00.000Z");
    writeSession("a", "2026-01-09T00:00:00.000Z");
    const manager = new AgentManager({
      home: agentDir,
      command: () => ({ bin: "/nonexistent", args: [] }),
    });
    const catalog = new SessionCatalog({ agentDir });
    const hub = new StreamHub({
      manager,
      catalog,
      sidebar: sidebarStore(),
      prs: prStore(),
      guides: guides(),
    });
    await hub.ready;

    const list = catalog.sessions.bind(catalog);
    let running = 0;
    let mostRunning = 0;
    let scans = 0;
    let duringFirst: (() => void) | undefined = () => {
      // Lands after the first scan read the dir: only the follow-up can see it.
      writeSession("b", "2026-01-09T12:00:00.000Z");
      calls.push(hub.refreshCatalog(), hub.refreshCatalog(), hub.refreshCatalog());
    };
    vi.spyOn(catalog, "sessions").mockImplementation(async (filter) => {
      scans += 1;
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      const sessions = await list(filter);
      const during = duringFirst;
      duringFirst = undefined;
      during?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return sessions;
    });
    const calls: Promise<void>[] = [];
    await hub.refreshCatalog();
    expect(hub.baseline().sessions.map((s) => s.id)).toEqual(["a"]);
    await Promise.all(calls);
    expect(hub.baseline().sessions.map((s) => s.id)).toEqual(["b", "a"]);
    expect(scans).toBe(2);
    expect(mostRunning).toBe(1);

    await hub.refreshCatalog();
    expect(scans).toBe(3);
    hub.close();
  });

  it("broadcasts catalog when a worktree turns missing", async () => {
    vi.setSystemTime("2026-01-10T00:00:00.000Z");
    const root = realpathSync(agentDir);
    const { repo, main } = makeLayoutRepo(root, "r");
    const wt = join(repo, "wt");
    git(main, "worktree", "add", "-q", "-b", "wt", wt);
    writeSession("w", "2026-01-09T00:00:00.000Z", wt);
    const manager = new AgentManager({
      home: root,
      command: () => ({ bin: "/nonexistent", args: [] }),
    });
    const hub = new StreamHub({
      manager,
      catalog: new SessionCatalog({ agentDir }),
      sidebar: sidebarStore(),
      prs: prStore(),
      guides: guides(),
    });
    await hub.ready;
    const frames: StreamFrame[] = [];
    hub.subscribe((f) => frames.push(f));
    expect(hub.baseline().sessions[0]?.layout).toEqual({ repo, role: "worktree", main });

    rmSync(wt, { recursive: true });
    await hub.refreshCatalog();
    expect(frames).toEqual([
      {
        type: "catalog",
        sessions: [
          expect.objectContaining({
            id: "w",
            layout: { repo, role: "worktree", main, missing: true },
          }),
        ],
      },
    ]);
    hub.close();
  });
});

describe("StreamHub sidebar state", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-hub-sidebar-")));
    mkdirSync(join(root, "agent", "sessions"), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("puts the state in the baseline, broadcasts changes and prunes on catalog refresh", async () => {
    const folder = join(root, "folder");
    mkdirSync(folder);
    const manager = new AgentManager({
      home: root,
      command: () => ({ bin: "/nonexistent", args: [] }),
    });
    const sidebar = new SidebarStateStore(join(root, "data"));
    const hub = new StreamHub({
      manager,
      catalog: new SessionCatalog({ agentDir: join(root, "agent") }),
      sidebar,
      prs: new PrStore(join(root, "data")),
      guides: guides(),
    });
    await hub.ready;
    const frames: StreamFrame[] = [];
    hub.subscribe((f) => frames.push(f));

    await sidebar.update({ collapsed: { [folder]: true } });
    expect(hub.baseline().sidebar).toEqual({ pinned: [], collapsed: [folder], mains: {} });
    expect(frames).toEqual([
      { type: "sidebar", sidebar: { pinned: [], collapsed: [folder], mains: {} } },
    ]);

    rmSync(folder, { recursive: true });
    await hub.refreshCatalog();
    await sidebar.update({}); // queued after the refresh's prune
    expect(frames.at(-1)).toEqual({
      type: "sidebar",
      sidebar: { pinned: [], collapsed: [], mains: {} },
    });
    hub.close();
  });

  it("sends each pinned repo's main checkout, resolved when sent", async () => {
    const { repo, main } = makeLayoutRepo(root, "r", { branches: ["master"], checkout: "master" });
    const manager = new AgentManager({
      home: root,
      command: () => ({ bin: "/nonexistent", args: [] }),
    });
    const sidebar = new SidebarStateStore(join(root, "data"));
    const hub = new StreamHub({
      manager,
      catalog: new SessionCatalog({ agentDir: join(root, "agent") }),
      sidebar,
      prs: new PrStore(join(root, "data")),
      guides: guides(),
    });
    await hub.ready;
    const frames: StreamFrame[] = [];
    hub.subscribe((f) => frames.push(f));

    await sidebar.update({ pinned: { [repo]: true } });
    const view = { pinned: [repo], collapsed: [], mains: { [repo]: main } };
    expect(frames).toEqual([{ type: "sidebar", sidebar: view }]);
    expect(hub.baseline().sidebar).toEqual(view);

    // A pin that no longer resolves to a main checkout has no entry.
    rmSync(main, { recursive: true });
    expect(hub.baseline().sidebar).toEqual({ pinned: [repo], collapsed: [], mains: {} });
    hub.close();
  });
});
