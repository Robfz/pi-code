import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../agents/agent-manager.ts";
import { SessionCatalog } from "../catalog/sessions.ts";
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
