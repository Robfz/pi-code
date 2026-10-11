import type { SessionSummary } from "@pi-code/protocol";
import { describe, expect, it } from "vitest";
import { groupPath } from "@/features/catalog/listing-groups";
import { makeAgent } from "@/test/fixtures";
import {
  agentMatches,
  allRows,
  buildSidebarGroups,
  hiddenMarks,
  liveBranch,
} from "./sidebar-model";

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
  it("groups by cwd, groups by their latest prompt, rows by their last prompt", () => {
    const groups = buildSidebarGroups({
      agents: [makeAgent({ id: "a1", cwd: "/home/me/alpha", sessionFile: "f1" })],
      sessions: [
        session({ file: "f1", cwd: "/home/me/alpha", lastPromptAt: at(3) }),
        session({ file: "s1", cwd: "/home/me/beta", lastPromptAt: at(5) }),
        session({ file: "s2", cwd: "/home/me/alpha", lastPromptAt: at(4), name: "Newer" }),
        session({ file: "s3", cwd: "/home/me/beta", lastPromptAt: at(1), firstMessage: "hi" }),
      ],
    });
    expect(groups.map(groupPath)).toEqual(["/home/me/beta", "/home/me/alpha"]);
    expect(groups[0]?.items.map((r) => r.key)).toEqual(["s1", "s3"]);
    expect(groups[1]?.items.map((r) => r.key)).toEqual(["s2", "a1"]);
    expect(groups[0]?.items.map((r) => r.title)).toEqual(["New conversation", "hi"]);
    expect(groups[1]?.items[0]?.title).toBe("Newer");
  });

  it("orders by prompts only: opening, restarting and agent output move nothing", () => {
    const groups = buildSidebarGroups({
      agents: [
        // Restarted today on a session last prompted on day 2.
        makeAgent({ id: "old", sessionFile: "f-old", startedAt: at(9) }),
        // The agent wrote on day 10, after its last prompt.
        makeAgent({ id: "busy", sessionFile: "f-busy", startedAt: at(1) }),
        // Opened today, never prompted, no session file yet.
        makeAgent({ id: "fresh", startedAt: at(11) }),
      ],
      sessions: [
        session({ file: "f-old", lastPromptAt: at(2), updatedAt: at(2) }),
        session({ file: "f-busy", lastPromptAt: at(3), updatedAt: at(10) }),
        session({ file: "f-free", lastPromptAt: at(5), updatedAt: at(5) }),
        // Written but never prompted (created on day 4).
        session({ file: "f-empty", createdAt: at(4), updatedAt: at(4) }),
      ],
    });
    const rows = groups[0]?.items ?? [];
    expect(rows.map((r) => r.key)).toEqual(["f-free", "busy", "old", "fresh", "f-empty"]);
    expect(rows.map((r) => r.recency)).toEqual([
      { prompted: true, at: Date.parse(at(5)) },
      { prompted: true, at: Date.parse(at(3)) },
      { prompted: true, at: Date.parse(at(2)) },
      { prompted: false, at: Date.parse(at(11)) },
      { prompted: false, at: Date.parse(at(4)) },
    ]);
  });

  it("puts groups without any prompt last, by their newest creation", () => {
    const groups = buildSidebarGroups({
      agents: [makeAgent({ id: "fresh", cwd: "/home/me/new", startedAt: at(9) })],
      sessions: [
        session({ file: "1", cwd: "/home/me/old", lastPromptAt: at(1) }),
        session({ file: "2", cwd: "/home/me/empty", createdAt: at(8) }),
      ],
    });
    expect(groups.map(groupPath)).toEqual(["/home/me/old", "/home/me/new", "/home/me/empty"]);
  });

  it("lists pinned repos first by label, case-insensitive and numeric-aware", () => {
    const repo = (name: string) => `/home/me/${name}`;
    const layout = (name: string) => ({ repo: repo(name), role: "main" as const });
    const groups = buildSidebarGroups({
      agents: [],
      sessions: [
        session({ file: "1", cwd: "/home/me/recent", lastPromptAt: at(9) }),
        session({ file: "2", cwd: `${repo("app10")}/main`, layout: layout("app10") }),
        session({ file: "3", cwd: `${repo("App9")}/main`, layout: layout("App9") }),
        session({ file: "4", cwd: `${repo("zeta")}/main`, layout: layout("zeta") }),
        session({ file: "5", cwd: `${repo("beta")}/main`, layout: layout("beta") }),
      ],
      pinned: [repo("zeta"), repo("app10"), repo("App9"), repo("empty")],
    });
    expect(groups.map((g) => g.label)).toEqual([
      "App9",
      "app10",
      "empty",
      "zeta",
      "recent",
      "beta",
    ]);
    // The pinned repo with no conversations has an empty group.
    expect(groups[2]).toMatchObject({ kind: "repo", items: [], worktrees: [] });
  });

  it("sorts pinned repos by their displayed label, collision prefix included", () => {
    const groups = buildSidebarGroups({
      agents: [],
      sessions: [session({ file: "1", cwd: "/home/me/b/tool", lastPromptAt: at(1) })],
      pinned: ["/home/me/z/tool", "/home/me/a/tool"],
    });
    expect(groups.map((g) => g.label)).toEqual(["a/tool", "z/tool", "b/tool"]);
  });

  it("adds no empty pinned repo to search results", () => {
    const groups = buildSidebarGroups({
      agents: [],
      sessions: [],
      pinned: ["/home/me/repo"],
      query: "x",
    });
    expect(groups).toEqual([]);
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
    });
    const rows = groups.flatMap((g) => g.items);
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
    });
    expect(group?.items[0]?.title).toBe("New conversation");
  });

  it("prepends the parent's basename when displayed groups share a basename", () => {
    const groups = buildSidebarGroups({
      agents: [],
      sessions: [
        session({ file: "1", cwd: "/home/me/Kepi/phoenix", lastPromptAt: at(3) }),
        session({ file: "2", cwd: "/home/me/phoenix/phoenix", lastPromptAt: at(2) }),
        session({ file: "3", cwd: "/home/me/pi-code/", lastPromptAt: at(1) }),
      ],
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
    });
    const branches = {
      "/r/ready": "main",
      "/r/starting": "dev",
      "/r/trust": "wip",
      "/r/exited": "old",
      "/r/disk": "stale",
    };
    const branch = (cwd: string) =>
      liveBranch(branches, cwd, groups.find((g) => groupPath(g) === cwd)?.items ?? []);
    expect(branch("/r/ready")).toBe("main");
    expect(branch("/r/starting")).toBe("dev");
    expect(branch("/r/trust")).toBe("wip");
    expect(branch("/r/exited")).toBeUndefined();
    expect(branch("/r/disk")).toBeUndefined();
  });

  it("places rows by layout, an agent's from its session's latest scan", () => {
    const repo = "/home/me/pi-code";
    const groups = buildSidebarGroups({
      agents: [
        // Opened before the folder was deleted; its session's scan says it's gone.
        makeAgent({
          id: "a1",
          cwd: `${repo}/spike`,
          sessionFile: "f1",
          layout: { repo, role: "worktree" },
        }),
        // A fresh worktree: no session file yet.
        makeAgent({
          id: "a2",
          cwd: `${repo}/fresh`,
          startedAt: at(9),
          layout: { repo, role: "worktree" },
        }),
      ],
      sessions: [
        session({
          file: "f1",
          cwd: `${repo}/spike`,
          layout: { repo, role: "worktree", missing: true },
        }),
      ],
    });
    expect(groups).toHaveLength(1);
    const [group] = groups;
    if (group?.kind !== "repo") throw new Error("expected a repo group");
    expect(group.worktrees.map((w) => [w.label, w.missing])).toEqual([
      ["fresh", false],
      ["spike", true],
    ]);
    expect(group.worktrees[1]?.items[0]?.layout?.missing).toBe(true);
  });

  it("marks a folder missing from its sessions, an agent's included", () => {
    const groups = buildSidebarGroups({
      agents: [makeAgent({ id: "a1", cwd: "/home/me/gone", sessionFile: "f1" })],
      sessions: [
        session({ file: "f1", cwd: "/home/me/gone", missing: true }),
        session({ file: "s1", cwd: "/home/me/here" }),
      ],
    });
    expect(groups.map((g) => g.kind === "folder" && [g.label, g.missing])).toEqual([
      ["gone", true],
      ["here", false],
    ]);
    expect(groups[0]?.items.map((r) => [r.key, r.missing])).toEqual([["a1", true]]);
  });
});

describe("hiddenMarks", () => {
  it("marks Working while any hidden row works, then the most urgent attention", () => {
    const groups = buildSidebarGroups({
      agents: [
        makeAgent({ id: "1", attention: "finished" }),
        makeAgent({ id: "2", attention: "failed", status: "exited" }),
        makeAgent({ id: "3", status: "starting" }),
      ],
      sessions: [session({ file: "s" })],
    });
    const rows = groups.flatMap(allRows);
    expect(hiddenMarks(rows)).toEqual(["working", "failed"]);
    expect(hiddenMarks(rows.filter((r) => r.key !== "2"))).toEqual(["working", "finished"]);
    const asking = buildSidebarGroups({
      agents: [makeAgent({ id: "4", attention: "input", isStreaming: true })],
      sessions: [],
    }).flatMap(allRows);
    expect(hiddenMarks([...rows, ...asking])).toEqual(["working", "input"]);
    const trust = buildSidebarGroups({
      agents: [makeAgent({ id: "5", status: "awaiting_trust" })],
      sessions: [],
    }).flatMap(allRows);
    expect(hiddenMarks(trust)).toEqual(["input"]);
    expect(hiddenMarks(rows.filter((r) => r.key === "s"))).toEqual([]);
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
      query: "design",
    });
    expect(groups.flatMap((g) => g.items.map((r) => r.key))).toEqual(["a1"]);
  });

  it("never shows a session held by an agent the query hides", () => {
    const groups = buildSidebarGroups({
      agents: [makeAgent({ id: "a1", cwd: "/x", sessionName: "Unrelated", sessionFile: "held" })],
      sessions: [session({ file: "held", name: "Phoenix match" })],
      query: "phoenix",
    });
    expect(groups).toEqual([]);
  });
});
