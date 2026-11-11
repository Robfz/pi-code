import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatPrBlock, formatPrGuideBlock } from "@pi-code/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, makeLayoutRepo } from "../testing/layout-repo.ts";
import {
  FIRST_MESSAGE_MAX,
  parseSessionFile,
  readSessionHeader,
  SessionCatalog,
} from "./sessions.ts";

const TEST_DATA = fileURLToPath(new URL("../../test-data", import.meta.url));
const SESSIONS = join(TEST_DATA, "sessions");
const proj = (name: string) => join(SESSIONS, "--home-user-proj--", name);
const other = (name: string) => join(SESSIONS, "--home-user-other--", name);

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pi-code-catalog-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("session summaries (fixture files)", () => {
  it("summarizes every session file and skips files without a header", async () => {
    const catalog = new SessionCatalog({ agentDir: TEST_DATA });
    const sessions = await catalog.sessions();
    // The fixtures' cwds are not on disk.
    expect(sessions).toEqual([
      {
        file: proj("2026-01-02T09-00-00-000Z_forked.jsonl"),
        id: "forked",
        cwd: "/home/user/proj",
        firstMessage: "Only a question, never answered",
        createdAt: "2026-01-02T09:00:00.000Z",
        updatedAt: "2026-01-02T09:00:01.000Z",
        missing: true,
        lastPromptAt: "2026-01-02T09:00:01.000Z",
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
        missing: true,
        // The second of its two prompts; later entries are the agent's and session info.
        lastPromptAt: "2026-01-01T10:00:07.000Z",
      },
      {
        // v2 (hookMessage role), a malformed line, a name that was cleared, a truncated last line.
        file: other("2025-09-01T12-00-00-000Z_v2-hook.jsonl"),
        id: "v2-hook",
        cwd: "/home/user/other",
        firstMessage: "v2 question",
        createdAt: "2025-09-01T12:00:00.000Z",
        updatedAt: "2025-09-01T12:00:04.000Z",
        missing: true,
        lastPromptAt: "2025-09-01T12:00:02.000Z",
      },
      {
        // v1: no version, entries without id / parentId.
        file: proj("2025-06-01T08-00-00-000Z_v1-legacy.jsonl"),
        id: "v1-legacy",
        cwd: "/home/user/proj",
        firstMessage: "hello from v1",
        createdAt: "2025-06-01T08:00:00.000Z",
        updatedAt: "2025-06-01T08:05:00.000Z",
        missing: true,
        lastPromptAt: "2025-06-01T08:00:01.000Z",
      },
      {
        // Never prompted: after every prompted session, however recent.
        file: other("2025-09-03T12-00-00-000Z_header-only.jsonl"),
        id: "header-only",
        cwd: "/home/user/other",
        createdAt: "2025-09-03T12:00:00.000Z",
        updatedAt: "2025-09-03T12:00:00.000Z",
        missing: true,
      },
    ]);
  });

  it("filters by cwd and reports owners", async () => {
    const owned = proj("2025-06-01T08-00-00-000Z_v1-legacy.jsonl");
    const catalog = new SessionCatalog({
      agentDir: TEST_DATA,
      ownerOf: (file) => (file === owned ? "agent-1" : undefined),
    });
    const sessions = await catalog.sessions({ cwd: "/home/user/proj" });
    expect(sessions.map((s) => s.id)).toEqual(["forked", "v3-full", "v1-legacy"]);
    expect(sessions.map((s) => s.ownedBy)).toEqual([undefined, undefined, "agent-1"]);
    expect(await catalog.sessions({ cwd: "/home/user/none" })).toEqual([]);
  });

  it("matches q against cwd and name, case-insensitively, combined with cwd", async () => {
    const catalog = new SessionCatalog({ agentDir: TEST_DATA });
    const ids = async (filter: { cwd?: string; q?: string }) =>
      (await catalog.sessions(filter)).map((s) => s.id);
    expect(await ids({ q: "USER/OTHER" })).toEqual(["v2-hook", "header-only"]);
    expect(await ids({ q: "renamed SESSION" })).toEqual(["v3-full"]);
    expect(await ids({ q: "renamed", cwd: "/home/user/other" })).toEqual([]);
    expect(await ids({ q: "user", cwd: "/home/user/other" })).toEqual(["v2-hook", "header-only"]);
    // Not matched: the first message, the file name.
    expect(await ids({ q: "failing test" })).toEqual([]);
    expect(await ids({ q: "legacy" })).toEqual([]);
  });

  it("lists projects by their last prompt with counts", async () => {
    const catalog = new SessionCatalog({ agentDir: TEST_DATA });
    expect(await catalog.projects()).toEqual([
      {
        cwd: "/home/user/proj",
        sessionCount: 3,
        lastPromptAt: "2026-01-02T09:00:01.000Z",
        createdAt: "2026-01-02T09:00:00.000Z",
        isGitRepo: false,
      },
      {
        cwd: "/home/user/other",
        sessionCount: 2,
        lastPromptAt: "2025-09-01T12:00:02.000Z",
        createdAt: "2025-09-03T12:00:00.000Z",
        isGitRepo: false,
      },
    ]);
  });

  it("orders unprompted projects after prompted ones, newest created first", async () => {
    const dir = join(tmp, "agent", "sessions", "--x--");
    mkdirSync(dir, { recursive: true });
    const write = (id: string, cwd: string, created: string, promptAt?: string) => {
      const lines = [{ type: "session", id, timestamp: created, cwd }];
      if (promptAt) {
        lines.push({
          type: "message",
          timestamp: promptAt,
          message: { role: "user", content: "x" },
        } as never);
      }
      writeFileSync(
        join(dir, `${id}.jsonl`),
        `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
      );
    };
    write("a", "/a", "2026-01-05T00:00:00.000Z");
    write("b", "/b", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    write("c", "/c", "2026-01-06T00:00:00.000Z");
    write("d", "/d", "2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
    const catalog = new SessionCatalog({ agentDir: join(tmp, "agent") });
    expect((await catalog.projects()).map((p) => p.cwd)).toEqual(["/d", "/b", "/c", "/a"]);
    expect((await catalog.sessions()).map((s) => s.id)).toEqual(["d", "b", "c", "a"]);
  });

  it("returns nothing for a missing sessions dir", async () => {
    const catalog = new SessionCatalog({ agentDir: join(tmp, "missing") });
    expect(await catalog.sessions()).toEqual([]);
    expect(await catalog.projects()).toEqual([]);
  });
});

describe("parseSessionFile", () => {
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: "s",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/p",
  });
  const user = (content: unknown, ts = "2026-01-01T00:00:01.000Z") =>
    JSON.stringify({
      type: "message",
      id: "u",
      parentId: null,
      timestamp: ts,
      message: { role: "user", content },
    });

  it("truncates the first message to 200 characters", () => {
    const long = "é".repeat(150) + "😀".repeat(100);
    const s = parseSessionFile("/f.jsonl", `${header}\n${user(long)}\n`, "x");
    expect(Array.from(s?.firstMessage ?? "")).toHaveLength(FIRST_MESSAGE_MAX);
    expect(s?.firstMessage?.endsWith("…")).toBe(true);
    expect(s?.firstMessage?.includes("\uFFFD")).toBe(false);
  });

  it("takes the last user message's time as lastPromptAt, not agent output after it", () => {
    const assistant = JSON.stringify({
      type: "message",
      timestamp: "2026-01-01T00:00:09.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "user" }] },
    });
    const s = parseSessionFile(
      "/f.jsonl",
      `${header}\n${user("one")}\n${user([{ type: "image", data: "x" }], "2026-01-01T00:00:05.000Z")}\n${assistant}\n`,
      "x",
    );
    expect(s).toMatchObject({
      lastPromptAt: "2026-01-01T00:00:05.000Z",
      updatedAt: "2026-01-01T00:00:09.000Z",
    });
    expect(parseSessionFile("/f.jsonl", `${header}\n`, "x")).not.toHaveProperty("lastPromptAt");
  });

  it("skips user messages without text and falls back for missing fields", () => {
    const s = parseSessionFile(
      "/dir/2026_abc.jsonl",
      `${JSON.stringify({ type: "session" })}\n${user([{ type: "image", data: "x" }])}\n${user("  ")}\n${user("real one")}\n`,
      "2020-01-01T00:00:00.000Z",
    );
    expect(s).toMatchObject({
      id: "abc",
      cwd: "",
      firstMessage: "real one",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
  });

  it("leaves attached text files out of the first message", () => {
    const files =
      '<file name="a.ts">\nconst a = 1;\n</file>\n<file name="/x/b.md">\n# B\n</file>\n';
    const withText = parseSessionFile(
      "/f.jsonl",
      `${header}\n${user([{ type: "text", text: `${files}review these` }])}\n`,
      "x",
    );
    expect(withText?.firstMessage).toBe("review these");
    const filesOnly = parseSessionFile("/f.jsonl", `${header}\n${user(files)}\n`, "x");
    expect(filesOnly?.firstMessage).toBe("(file: a.ts, b.md)");
  });

  it("names the PR of a `/pr` prompt", () => {
    const block = formatPrBlock({
      number: 7,
      title: "Add things",
      state: "open",
      url: "https://github.com/o/r/pull/7",
      update: false,
      text: "Pull request o/r#7: Add things\n…",
    });
    const s = parseSessionFile(
      "/f.jsonl",
      `${header}\n${user(`${block}Give me an overview`)}\n`,
      "x",
    );
    expect(s?.firstMessage).toBe("#7 Add things");
  });

  it("names the PR of a guide prompt and the command of an expanded skill", () => {
    const block = formatPrGuideBlock({
      number: 7,
      title: "Add things",
      url: "https://github.com/o/r/pull/7",
      text: "Review guide for o/r#7\n…",
    });
    const guide = parseSessionFile("/f.jsonl", `${header}\n${user(`${block}Read it`)}\n`, "x");
    expect(guide?.firstMessage).toBe("#7 Add things (guide)");
    const skill = '<skill name="review" location="/s/SKILL.md">\nSteps\n</skill>\n\nthe diff';
    const skilled = parseSessionFile("/f.jsonl", `${header}\n${user(skill)}\n`, "x");
    expect(skilled?.firstMessage).toBe("/skill:review the diff");
  });

  it("rejects content whose first record isn't a header", () => {
    expect(parseSessionFile("/f", "", "x")).toBeUndefined();
    expect(parseSessionFile("/f", `${user("x")}\n${header}\n`, "x")).toBeUndefined();
  });

  it("reads a session header", async () => {
    expect(await readSessionHeader(proj("2026-01-01T10-00-00-000Z_v3-full.jsonl"))).toEqual({
      id: "v3-full",
      cwd: "/home/user/proj",
    });
    expect(
      await readSessionHeader(other("2025-09-02T12-00-00-000Z_no-header.jsonl")),
    ).toBeUndefined();
    expect(await readSessionHeader(join(tmp, "missing.jsonl"))).toBeUndefined();
  });
});

describe("SessionCatalog cache", () => {
  it("re-reads a file only when its mtime or size changes", async () => {
    const agentDir = join(tmp, "agent");
    cpSync(TEST_DATA, agentDir, { recursive: true });
    const file = join(
      agentDir,
      "sessions",
      "--home-user-proj--",
      "2026-01-02T09-00-00-000Z_forked.jsonl",
    );
    const catalog = new SessionCatalog({ agentDir });
    const first = (await catalog.sessions()).find((s) => s.id === "forked");
    expect(first?.name).toBeUndefined();

    appendFileSync(
      file,
      `${JSON.stringify({ type: "session_info", id: "n", parentId: "f0000001", timestamp: "2026-02-01T00:00:00.000Z", name: "Later" })}\n`,
    );
    catalog.invalidate();
    const second = (await catalog.sessions()).find((s) => s.id === "forked");
    expect(second).toMatchObject({ name: "Later", updatedAt: "2026-02-01T00:00:00.000Z" });
    expect((await catalog.sessions())[0]?.id).toBe("forked");

    // New and deleted files are picked up.
    rmSync(file);
    const dir = join(agentDir, "sessions", "--home-user-new--");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "x.jsonl"),
      `${JSON.stringify({ type: "session", id: "new", timestamp: "2027-01-01T00:00:00.000Z", cwd: "/home/user/new" })}\n${JSON.stringify({ type: "message", timestamp: "2027-01-01T00:00:01.000Z", message: { role: "user", content: "hi" } })}\n`,
    );
    catalog.invalidate();
    const ids = (await catalog.sessions()).map((s) => s.id);
    expect(ids[0]).toBe("new");
    expect(ids).not.toContain("forked");
    expect([...(await catalog.sessionCwds())].sort()).toEqual([
      "/home/user/new",
      "/home/user/other",
      "/home/user/proj",
    ]);
  });

  it("flags projects inside git work trees", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, ".git", "objects"), { recursive: true });
    mkdirSync(join(repo, "sub"));
    const dir = join(tmp, "agent", "sessions", "--x--");
    mkdirSync(dir, { recursive: true });
    for (const [name, cwd] of [
      ["a", join(repo, "sub")],
      ["b", tmp],
    ] as const) {
      writeFileSync(
        join(dir, `${name}.jsonl`),
        `${JSON.stringify({ type: "session", id: name, timestamp: `2026-01-0${name === "a" ? 2 : 1}T00:00:00.000Z`, cwd })}\n`,
      );
    }
    const projects = await new SessionCatalog({ agentDir: join(tmp, "agent") }).projects();
    expect(projects.map((p) => [p.cwd, p.isGitRepo])).toEqual([
      [join(repo, "sub"), true],
      [tmp, false],
    ]);
  });
});

describe("SessionCatalog layout", () => {
  it("attaches each cwd's layout to sessions and projects, recomputed per scan", async () => {
    const root = realpathSync(tmp);
    const { repo, main } = makeLayoutRepo(root, "r");
    const wt = join(repo, "wt");
    git(main, "worktree", "add", "-q", "-b", "wt", wt);
    const plain = join(root, "plain");
    git(root, "clone", "-q", join(root, "r.git"), plain);
    const dir = join(root, "agent", "sessions", "--x--");
    mkdirSync(dir, { recursive: true });
    const cwds = { container: repo, main, wt, plain };
    Object.entries(cwds).forEach(([id, cwd], i) => {
      writeFileSync(
        join(dir, `${id}.jsonl`),
        `${JSON.stringify({ type: "session", id, timestamp: `2026-01-0${i + 1}T00:00:00.000Z`, cwd })}\n`,
      );
    });
    const catalog = new SessionCatalog({ agentDir: join(root, "agent") });

    const layouts = Object.fromEntries((await catalog.sessions()).map((s) => [s.id, s.layout]));
    expect(layouts).toEqual({
      container: { repo, role: "container", main },
      main: { repo, role: "main", main },
      wt: { repo, role: "worktree", main },
      plain: undefined,
    });
    expect((await catalog.sessions())[0]).not.toHaveProperty("layout");
    expect((await catalog.projects()).map((p) => [p.cwd, p.layout])).toEqual([
      [plain, undefined],
      [wt, { repo, role: "worktree", main }],
      [main, { repo, role: "main", main }],
      [repo, { repo, role: "container", main }],
    ]);

    rmSync(wt, { recursive: true });
    catalog.invalidate();
    expect((await catalog.sessions()).find((s) => s.id === "wt")?.layout).toEqual({
      repo,
      role: "worktree",
      main,
      missing: true,
    });
  });
});

describe("SessionCatalog missing folders", () => {
  it("marks the sessions whose cwd is gone, recomputed per scan", async () => {
    const kept = join(tmp, "kept");
    const gone = join(tmp, "gone");
    mkdirSync(kept);
    mkdirSync(gone);
    const dir = join(tmp, "agent", "sessions", "--x--");
    mkdirSync(dir, { recursive: true });
    for (const [id, cwd] of [
      ["kept", kept],
      ["gone", gone],
    ] as const) {
      const header = { type: "session", id, timestamp: "2026-01-01T00:00:00.000Z", cwd };
      writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify(header)}\n`);
    }
    const catalog = new SessionCatalog({ agentDir: join(tmp, "agent") });
    const missing = async () =>
      Object.fromEntries((await catalog.sessions()).map((s) => [s.id, s.missing]));
    expect(await missing()).toEqual({ kept: undefined, gone: undefined });

    rmSync(gone, { recursive: true });
    catalog.invalidate();
    expect(await missing()).toEqual({ kept: undefined, gone: true });
    expect((await catalog.sessions()).find((s) => s.id === "kept")).not.toHaveProperty("missing");
  });
});
