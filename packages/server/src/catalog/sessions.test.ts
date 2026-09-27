import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    expect(sessions).toEqual([
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
      {
        file: other("2025-09-03T12-00-00-000Z_header-only.jsonl"),
        id: "header-only",
        cwd: "/home/user/other",
        createdAt: "2025-09-03T12:00:00.000Z",
        updatedAt: "2025-09-03T12:00:00.000Z",
      },
      {
        // v2 (hookMessage role), a malformed line, a name that was cleared, a truncated last line.
        file: other("2025-09-01T12-00-00-000Z_v2-hook.jsonl"),
        id: "v2-hook",
        cwd: "/home/user/other",
        firstMessage: "v2 question",
        createdAt: "2025-09-01T12:00:00.000Z",
        updatedAt: "2025-09-01T12:00:04.000Z",
      },
      {
        // v1: no version, entries without id / parentId.
        file: proj("2025-06-01T08-00-00-000Z_v1-legacy.jsonl"),
        id: "v1-legacy",
        cwd: "/home/user/proj",
        firstMessage: "hello from v1",
        createdAt: "2025-06-01T08:00:00.000Z",
        updatedAt: "2025-06-01T08:05:00.000Z",
      },
    ]);
  });

  it("filters by cwd and reports owners", async () => {
    const owned = proj("2025-06-01T08-00-00-000Z_v1-legacy.jsonl");
    const catalog = new SessionCatalog({
      agentDir: TEST_DATA,
      ownerOf: (file) => (file === owned ? "agent-1" : undefined),
    });
    const sessions = await catalog.sessions("/home/user/proj");
    expect(sessions.map((s) => s.id)).toEqual(["forked", "v3-full", "v1-legacy"]);
    expect(sessions.map((s) => s.ownedBy)).toEqual([undefined, undefined, "agent-1"]);
    expect(await catalog.sessions("/home/user/none")).toEqual([]);
  });

  it("lists projects by recent activity with counts", async () => {
    const catalog = new SessionCatalog({ agentDir: TEST_DATA });
    expect(await catalog.projects()).toEqual([
      {
        cwd: "/home/user/proj",
        sessionCount: 3,
        updatedAt: "2026-01-02T09:00:01.000Z",
        isGitRepo: false,
      },
      {
        cwd: "/home/user/other",
        sessionCount: 2,
        updatedAt: "2025-09-03T12:00:00.000Z",
        isGitRepo: false,
      },
    ]);
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
      `${JSON.stringify({ type: "session", id: "new", timestamp: "2027-01-01T00:00:00.000Z", cwd: "/home/user/new" })}\n`,
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
