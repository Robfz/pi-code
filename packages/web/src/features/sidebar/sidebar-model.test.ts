import type { SessionSummary } from "@pi-code/protocol";
import { describe, expect, it } from "vitest";
import { makeAgent } from "@/test/fixtures";
import { agentMatches, buildSidebarGroups } from "./sidebar-model";

function session(patch: Partial<SessionSummary> & { file: string }): SessionSummary {
  return {
    id: patch.file,
    cwd: "/home/me/project",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

const at = (day: number, hour = 0) =>
  `2026-01-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;

describe("buildSidebarGroups", () => {
  it("groups by cwd, groups by their most recent row, rows by activity", () => {
    const groups = buildSidebarGroups({
      agents: [makeAgent({ id: "a1", cwd: "/home/me/alpha", startedAt: at(3) })],
      sessions: [
        session({ file: "s1", cwd: "/home/me/beta", updatedAt: at(5) }),
        session({ file: "s2", cwd: "/home/me/alpha", updatedAt: at(4), name: "Newer" }),
        session({ file: "s3", cwd: "/home/me/beta", updatedAt: at(1), firstMessage: "hi" }),
      ],
      branches: {},
    });
    expect(groups.map((g) => g.cwd)).toEqual(["/home/me/beta", "/home/me/alpha"]);
    expect(groups[0]?.rows.map((r) => r.key)).toEqual(["s1", "s3"]);
    expect(groups[1]?.rows.map((r) => r.key)).toEqual(["s2", "a1"]);
    expect(groups[0]?.rows.map((r) => r.title)).toEqual(["New conversation", "hi"]);
    expect(groups[1]?.rows[0]?.title).toBe("Newer");
  });

  it("takes an agent's activity as the later of its start and its session's update", () => {
    const groups = buildSidebarGroups({
      agents: [
        // Restarted today on an old session.
        makeAgent({ id: "old", sessionFile: "f-old", startedAt: at(9) }),
        // Started long ago, session written recently.
        makeAgent({ id: "busy", sessionFile: "f-busy", startedAt: at(1) }),
      ],
      sessions: [
        session({ file: "f-old", updatedAt: at(2) }),
        session({ file: "f-busy", updatedAt: at(10) }),
        session({ file: "f-free", updatedAt: at(5) }),
      ],
      branches: {},
    });
    const rows = groups[0]?.rows ?? [];
    expect(rows.map((r) => r.key)).toEqual(["busy", "old", "f-free"]);
    expect(rows[0]?.activity).toBe(Date.parse(at(10)));
    expect(rows[1]?.activity).toBe(Date.parse(at(9)));
  });

  it("hides session rows held by an agent and titles the agent from its session", () => {
    const groups = buildSidebarGroups({
      agents: [
        makeAgent({ id: "a1", sessionFile: "held" }),
        makeAgent({ id: "a2", sessionFile: "named", sessionName: "Renamed" }),
        makeAgent({ id: "a3", status: "exited", sessionFile: "gone" }),
      ],
      sessions: [
        session({ file: "held", firstMessage: "Fix the flaky test" }),
        session({ file: "named", name: "Old name" }),
        session({ file: "gone", name: "Exited one" }),
        session({ file: "free", name: "On disk" }),
      ],
      branches: {},
    });
    const rows = groups.flatMap((g) => g.rows);
    expect(rows.map((r) => r.key).sort()).toEqual(["a1", "a2", "a3", "free"]);
    const title = (key: string) => rows.find((r) => r.key === key)?.title;
    expect(title("a1")).toBe("Fix the flaky test");
    expect(title("a2")).toBe("Renamed");
    expect(title("a3")).toBe("Exited one");
  });

  it("titles agents without a known session 'New conversation'", () => {
    const [group] = buildSidebarGroups({
      agents: [makeAgent({ id: "a1" })],
      sessions: [],
      branches: {},
    });
    expect(group?.rows[0]?.title).toBe("New conversation");
  });

  it("prepends the parent's basename when displayed groups share a basename", () => {
    const groups = buildSidebarGroups({
      agents: [],
      sessions: [
        session({ file: "1", cwd: "/home/me/Kepi/phoenix", updatedAt: at(3) }),
        session({ file: "2", cwd: "/home/me/phoenix/phoenix", updatedAt: at(2) }),
        session({ file: "3", cwd: "/home/me/pi-code/", updatedAt: at(1) }),
      ],
      branches: {},
    });
    expect(groups.map((g) => g.label)).toEqual(["Kepi/phoenix", "phoenix/phoenix", "pi-code"]);
  });

  it("shows the branch only for folders with a live agent", () => {
    const groups = buildSidebarGroups({
      agents: [
        makeAgent({ id: "ready", cwd: "/r/ready", status: "ready" }),
        makeAgent({ id: "starting", cwd: "/r/starting", status: "starting" }),
        makeAgent({ id: "trust", cwd: "/r/trust", status: "awaiting_trust" }),
        makeAgent({ id: "exited", cwd: "/r/exited", status: "exited" }),
      ],
      sessions: [session({ file: "s", cwd: "/r/disk" })],
      branches: {
        "/r/ready": "main",
        "/r/starting": "dev",
        "/r/trust": "wip",
        "/r/exited": "old",
        "/r/disk": "stale",
      },
    });
    const branch = (cwd: string) => groups.find((g) => g.cwd === cwd)?.branch;
    expect(branch("/r/ready")).toBe("main");
    expect(branch("/r/starting")).toBe("dev");
    expect(branch("/r/trust")).toBe("wip");
    expect(branch("/r/exited")).toBeUndefined();
    expect(branch("/r/disk")).toBeUndefined();
  });
});

describe("agentMatches", () => {
  it("matches the displayed title and cwd path, ignoring case", () => {
    const row = { cwd: "/home/me/Phoenix", title: "Desktop Design" };
    expect(agentMatches(row, "phoe")).toBe(true);
    expect(agentMatches(row, "home/me")).toBe(true);
    expect(agentMatches(row, "design")).toBe(true);
    expect(agentMatches(row, "kepi")).toBe(false);
  });
});

describe("buildSidebarGroups with a query", () => {
  it("filters agents on their displayed title, including one taken from their session", () => {
    const groups = buildSidebarGroups({
      agents: [
        makeAgent({ id: "a1", cwd: "/x", sessionFile: "f1" }),
        makeAgent({ id: "a2", cwd: "/x", sessionName: "Other" }),
      ],
      sessions: [],
      known: [session({ file: "f1", firstMessage: "Fix the design" })],
      branches: {},
      query: "design",
    });
    expect(groups.flatMap((g) => g.rows.map((r) => r.key))).toEqual(["a1"]);
  });

  it("never shows a session held by an agent the query hides", () => {
    const groups = buildSidebarGroups({
      agents: [makeAgent({ id: "a1", cwd: "/x", sessionName: "Unrelated", sessionFile: "held" })],
      sessions: [session({ file: "held", name: "Phoenix match" })],
      branches: {},
      query: "phoenix",
    });
    expect(groups).toEqual([]);
  });
});
