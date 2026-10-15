import type { AgentInfo, SessionSummary } from "@pi-code/protocol";
import { describe, expect, it } from "vitest";
import { groupPath } from "@/features/catalog/listing-groups";
import { makeAgent } from "@/test/fixtures";
import {
  activeRows,
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
    const layout = (name: string) => ({
      repo: repo(name),
      role: "main" as const,
      main: `${repo(name)}/main`,
    });
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

  it("shows each repo's main checkout, even empty, except in search results", () => {
    const repo = "/home/me/pi-code";
    const pinned = "/home/me/tool";
    const sessions = [
      session({
        file: "w1",
        cwd: `${repo}/wt`,
        firstMessage: "match",
        layout: { repo, role: "worktree", main: `${repo}/main` },
      }),
    ];
    const mains = { [pinned]: `${pinned}/master` };
    const groups = buildSidebarGroups({ agents: [], sessions, pinned: [pinned], mains });
    expect(
      groups.map((g) => g.kind === "repo" && g.worktrees.map((w) => [w.cwd, w.items.length])),
    ).toEqual([
      [[`${pinned}/master`, 0]],
      [
        [`${repo}/main`, 0],
        [`${repo}/wt`, 1],
      ],
    ]);
    const found = buildSidebarGroups({
      agents: [],
      sessions,
      pinned: [pinned],
      mains,
      query: "match",
    });
    expect(found.map((g) => g.kind === "repo" && g.worktrees.map((w) => w.cwd))).toEqual([
      [`${repo}/wt`],
    ]);
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
          layout: { repo, role: "worktree", main: `${repo}/main` },
        }),
        // A fresh worktree: no session file yet.
        makeAgent({
          id: "a2",
          cwd: `${repo}/fresh`,
          startedAt: at(9),
          layout: { repo, role: "worktree", main: `${repo}/main` },
        }),
      ],
      sessions: [
        session({
          file: "f1",
          cwd: `${repo}/spike`,
          layout: { repo, role: "worktree", main: `${repo}/main`, missing: true },
        }),
      ],
    });
    expect(groups).toHaveLength(1);
    const [group] = groups;
    if (group?.kind !== "repo") throw new Error("expected a repo group");
    expect(group.worktrees.map((w) => [w.label, w.missing])).toEqual([
      ["main", false],
      ["fresh", false],
      ["spike", true],
    ]);
    expect(group.worktrees[2]?.items[0]?.layout?.missing).toBe(true);
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

describe("activeRows", () => {
  const repo = "/home/me/pi-code";
  const wt = (missing = false) => ({
    repo,
    role: "worktree" as const,
    main: `${repo}/main`,
    ...(missing ? { missing: true as const } : {}),
  });
  const active = (...args: Parameters<typeof buildSidebarGroups>) =>
    activeRows(buildSidebarGroups(...args));

  it("lists every live agent across groups, by last prompt, then the never-prompted by creation", () => {
    const rows = active({
      agents: [
        makeAgent({ id: "idle", cwd: "/home/me/alpha", sessionFile: "f-idle" }),
        makeAgent({ id: "fresh", cwd: "/home/me/beta", startedAt: at(9) }),
        makeAgent({ id: "older-fresh", cwd: "/home/me/alpha", startedAt: at(8) }),
        makeAgent({ id: "working", cwd: "/home/me/beta", sessionFile: "f-working" }),
        makeAgent({ id: "starting", cwd: "/home/me/gamma", status: "starting", startedAt: at(7) }),
        makeAgent({
          id: "trust",
          cwd: "/home/me/gamma",
          status: "awaiting_trust",
          startedAt: at(6),
        }),
        makeAgent({ id: "failed", cwd: "/home/me/gamma", attention: "failed", sessionFile: "f-f" }),
        makeAgent({ id: "done", cwd: "/home/me/alpha", attention: "finished", sessionFile: "f-d" }),
        makeAgent({ id: "exited", cwd: "/home/me/alpha", status: "exited", sessionFile: "f-x" }),
      ],
      sessions: [
        session({ file: "f-idle", cwd: "/home/me/alpha", lastPromptAt: at(2) }),
        session({ file: "f-working", cwd: "/home/me/beta", lastPromptAt: at(5) }),
        session({ file: "f-f", cwd: "/home/me/gamma", lastPromptAt: at(3) }),
        session({ file: "f-d", cwd: "/home/me/alpha", lastPromptAt: at(4) }),
        session({ file: "f-x", cwd: "/home/me/alpha", lastPromptAt: at(10) }),
        session({ file: "free", cwd: "/home/me/alpha", lastPromptAt: at(11) }),
      ],
    });
    expect(rows.map((r) => r.key)).toEqual([
      "working",
      "done",
      "failed",
      "idle",
      "fresh",
      "older-fresh",
      "starting",
      "trust",
    ]);
  });

  it("labels rows with their group, a checkout's as repo/checkout", () => {
    const rows = active({
      agents: [
        makeAgent({ id: "plain", cwd: "/home/me/Kepi/phoenix", startedAt: at(5) }),
        makeAgent({ id: "other", cwd: "/home/me/phoenix/phoenix", startedAt: at(4) }),
        makeAgent({
          id: "container",
          cwd: repo,
          startedAt: at(3),
          layout: { repo, role: "container", main: `${repo}/main` },
        }),
        makeAgent({
          id: "main",
          cwd: `${repo}/main`,
          startedAt: at(2),
          layout: { repo, role: "main", main: `${repo}/main` },
        }),
        makeAgent({ id: "wt", cwd: `${repo}/spike`, startedAt: at(1), layout: wt() }),
      ],
      sessions: [],
    });
    expect(rows.map((r) => [r.key, r.project])).toEqual([
      ["plain", "Kepi/phoenix"],
      ["other", "phoenix/phoenix"],
      ["container", "pi-code"],
      ["main", "pi-code/main"],
      ["wt", "pi-code/spike"],
    ]);
  });

  it("titles rows like the groups and follows the search query", () => {
    const agents = [
      makeAgent({ id: "a1", sessionFile: "f1" }),
      makeAgent({ id: "a2", sessionName: "Other" }),
    ];
    const known = [session({ file: "f1", firstMessage: "Fix the design" })];
    expect(active({ agents, sessions: known }).map((r) => r.title)).toEqual([
      "Fix the design",
      "Other",
    ]);
    expect(active({ agents, sessions: [], known, query: "design" }).map((r) => r.key)).toEqual([
      "a1",
    ]);
  });

  it("is empty without a live agent", () => {
    expect(
      active({
        agents: [makeAgent({ id: "x", status: "exited" })],
        sessions: [session({ file: "free" })],
      }),
    ).toEqual([]);
  });

  describe("removal", () => {
    // Each step is the registry after one frame of the server's sequence (`agent` replaces an
    // agent, `agent_closed` removes it, `catalog` replaces the sessions).
    const inWt = makeAgent({
      id: "wt",
      sessionFile: "f-wt",
      cwd: `${repo}/spike`,
      layout: wt(),
    });
    const other = makeAgent({ id: "other", sessionFile: "f-other" });
    const sessions = [
      session({ file: "f-wt", cwd: `${repo}/spike`, layout: wt(), lastPromptAt: at(2) }),
      session({ file: "f-other", lastPromptAt: at(1) }),
    ];
    const exited = (agent: AgentInfo): AgentInfo => ({ ...agent, status: "exited" });
    const keys = (agents: AgentInfo[], listed = sessions) =>
      active({ agents, sessions: listed }).map((r) => r.key);
    const without = (file: string) => sessions.filter((s) => s.file !== file);

    it("drops an agent whose pi exits, until it restarts", () => {
      expect(keys([inWt, other])).toEqual(["wt", "other"]);
      expect(keys([inWt, exited(other)])).toEqual(["wt"]);
      expect(keys([inWt, { ...other, status: "starting" }])).toEqual(["wt", "other"]);
    });

    it("drops the agents of a removed worktree: exited, closed, then their sessions gone", () => {
      expect(keys([exited(inWt), other])).toEqual(["other"]);
      expect(keys([other])).toEqual(["other"]);
      expect(keys([other], without("f-wt"))).toEqual(["other"]);
    });

    it("keeps an agent whose worktree went missing outside pi-code: its pi still runs", () => {
      const missing = sessions.map((s) => (s.file === "f-wt" ? { ...s, layout: wt(true) } : s));
      expect(keys([inWt, other], missing)).toEqual(["wt", "other"]);
    });
  });
});
