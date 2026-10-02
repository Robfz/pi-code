import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StreamFrame } from "@pi-code/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../agents/agent-manager.ts";
import { SessionCatalog } from "../catalog/sessions.ts";
import { git, makeLayoutRepo } from "../testing/layout-repo.ts";
import { StreamHub } from "./stream-hub.ts";

const TEST_DATA = fileURLToPath(new URL("../../test-data", import.meta.url));
const proj = (name: string) => join(TEST_DATA, "sessions", "--home-user-proj--", name);

function hubAt(now: string): StreamHub {
  vi.setSystemTime(now);
  const manager = new AgentManager({
    home: TEST_DATA,
    command: () => ({ bin: "/nonexistent", args: [] }),
  });
  // Every session is owned, so `ownedBy` would show up if it weren't stripped.
  const catalog = new SessionCatalog({ agentDir: TEST_DATA, ownerOf: () => "agent-1" });
  return new StreamHub({ manager, catalog });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StreamHub baseline", () => {
  it("holds the sessions updated within 7 days, most recent first, without ownedBy", async () => {
    // v3-full was last updated 2026-01-01T10:30:00.000Z: exactly 7 days before.
    const hub = hubAt("2026-01-08T10:30:00.000Z");
    await hub.ready;
    expect(hub.baseline()).toEqual({
      type: "baseline",
      agents: [],
      sessions: [
        {
          file: proj("2026-01-02T09-00-00-000Z_forked.jsonl"),
          id: "forked",
          cwd: "/home/user/proj",
          firstMessage: "Only a question, never answered",
          createdAt: "2026-01-02T09:00:00.000Z",
          updatedAt: "2026-01-02T09:00:01.000Z",
          parentSession: "/sessions/--home-user-proj--/2026-01-01T10-00-00-000Z_v3-full.jsonl",
        },
        {
          file: proj("2026-01-01T10-00-00-000Z_v3-full.jsonl"),
          id: "v3-full",
          cwd: "/home/user/proj",
          name: "Renamed session",
          firstMessage: "Fix the failing test please",
          createdAt: "2026-01-01T10:00:00.000Z",
          updatedAt: "2026-01-01T10:30:00.000Z",
        },
      ],
      branches: {},
    });
  });

  it("drops sessions older than 7 days", async () => {
    const hub = hubAt("2026-01-08T10:30:00.001Z");
    await hub.ready;
    expect(hub.baseline().sessions.map((s) => s.id)).toEqual(["forked"]);
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

  function writeSession(id: string, updatedAt: string, cwd = "/p"): void {
    const header = { type: "session", version: 3, id, timestamp: updatedAt, cwd };
    writeFileSync(
      join(agentDir, "sessions", "--p--", `${id}.jsonl`),
      `${JSON.stringify(header)}\n`,
    );
  }

  it("broadcasts catalog only when the window changes", async () => {
    vi.setSystemTime("2026-01-10T00:00:00.000Z");
    writeSession("a", "2026-01-09T00:00:00.000Z");
    const manager = new AgentManager({
      home: agentDir,
      command: () => ({ bin: "/nonexistent", args: [] }),
    });
    const hub = new StreamHub({ manager, catalog: new SessionCatalog({ agentDir }) });
    await hub.ready;
    const frames: StreamFrame[] = [];
    hub.subscribe((f) => frames.push(f));
    expect(hub.baseline().sessions.map((s) => s.id)).toEqual(["a"]);

    await hub.refreshCatalog();
    expect(frames).toEqual([]);

    writeSession("b", "2026-01-09T12:00:00.000Z");
    await hub.refreshCatalog();
    expect(frames.map((f) => f.type === "catalog" && f.sessions.map((s) => s.id))).toEqual([
      ["b", "a"],
    ]);
    // Outside the window: no change.
    writeSession("old", "2025-12-01T00:00:00.000Z");
    await hub.refreshCatalog();
    expect(frames).toHaveLength(1);

    // Time alone moves a session out of the window.
    vi.setSystemTime("2026-01-16T06:00:00.000Z");
    await hub.refreshCatalog();
    expect(frames.at(-1)).toEqual({ type: "catalog", sessions: [hub.baseline().sessions[0]] });
    expect(hub.baseline().sessions.map((s) => s.id)).toEqual(["b"]);
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
    const hub = new StreamHub({ manager, catalog: new SessionCatalog({ agentDir }) });
    await hub.ready;
    const frames: StreamFrame[] = [];
    hub.subscribe((f) => frames.push(f));
    expect(hub.baseline().sessions[0]?.layout).toEqual({ repo, role: "worktree" });

    rmSync(wt, { recursive: true });
    await hub.refreshCatalog();
    expect(frames).toEqual([
      {
        type: "catalog",
        sessions: [
          expect.objectContaining({ id: "w", layout: { repo, role: "worktree", missing: true } }),
        ],
      },
    ]);
    hub.close();
  });
});
