import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixturePath, loadFixture } from "../../../../test/fake-pi.ts";
import { SessionCatalog } from "./sessions.ts";

const TEST_DATA_SESSIONS = fileURLToPath(new URL("../../test-data/sessions", import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL("../../../../test/fixtures", import.meta.url));

/**
 * The session files under `test-data/sessions`, the ones `sessions.test.ts` lists, with their
 * `/home/user/...` cwds moved: on macOS `/home` is an autofs mount, and every scan stats each cwd.
 */
function testDataSessions(): [string, Buffer][] {
  return readdirSync(TEST_DATA_SESSIONS, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".jsonl"))
    .map((path) => [
      path,
      Buffer.from(
        readFileSync(join(TEST_DATA_SESSIONS, path), "utf8").replaceAll('"/home/', '"/test-data/'),
      ),
    ]);
}

/**
 * A session file per recorded fixture: a header, then every entry its `get_entries` responses
 * returned, in order. Real pi output: system prompts, tool results, non-ASCII text.
 */
function fixtureSessions(): [string, Buffer][] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const entries = new Map<string, Record<string, unknown>>();
      for (const { dir, line } of loadFixture(fixturePath(join(FIXTURES_DIR, name)))) {
        const response = line as {
          type?: string;
          command?: string;
          success?: boolean;
          data?: { entries: Record<string, unknown>[] };
        };
        if (dir !== "out" || response.type !== "response" || response.command !== "get_entries")
          continue;
        if (!response.success) continue;
        for (const entry of response.data?.entries ?? []) entries.set(String(entry.id), entry);
      }
      const first = [...entries.values()][0];
      const header = {
        type: "session",
        version: 3,
        id: basename(name, ".jsonl"),
        timestamp: first?.timestamp ?? "2026-01-01T00:00:00.000Z",
        cwd: `/fixtures/${basename(name, ".jsonl")}`,
      };
      const lines = [header, ...entries.values()].map((l) => JSON.stringify(l));
      return [name, Buffer.from(`${lines.join("\n")}\n`)];
    });
}

/** Deterministic PRNG (mulberry32), so failures reproduce. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pi-code-catalog-inc-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A sessions dir with one project dir; `file` is the session file in it. */
function setup(name = "s.jsonl") {
  const agentDir = join(tmp, "agent");
  const dir = join(agentDir, "sessions", "--p--");
  mkdirSync(dir, { recursive: true });
  return { agentDir, file: join(dir, name) };
}

/** The listing a fresh catalog (a full parse of every file) gives. */
async function fullParse(agentDir: string) {
  return new SessionCatalog({ agentDir }).sessions();
}

describe("SessionCatalog incremental parsing", () => {
  const files = [...testDataSessions(), ...fixtureSessions()];

  it("covers every session fixture", () => {
    expect(files.length).toBeGreaterThan(12);
    // Mid-UTF-8 cuts need multi-byte characters.
    expect(files.some(([, content]) => content.some((b) => b >= 0x80))).toBe(true);
  });

  it.each(files)(
    "summarizes %s grown in random pieces exactly as a full parse",
    async (name, content) => {
      const next = random(content.length);
      // Cuts inside multi-byte characters and right around newlines, plus random ones.
      const continuation: number[] = [];
      const newline: number[] = [];
      content.forEach((b, i) => {
        if ((b & 0xc0) === 0x80) continuation.push(i);
        if (b === 0x0a) newline.push(i, i + 1);
      });
      const pick = (from: number[]) => from[Math.floor(next() * from.length)];
      const cutSets: number[][] = [];
      for (let i = 0; i < 16; i++) {
        const count = 1 + Math.floor(next() * 3);
        const cuts = new Set<number>();
        for (let c = 0; c < count; c++) {
          const kind = next();
          const at =
            kind < 0.25 && continuation.length > 0
              ? pick(continuation)
              : kind < 0.4 && newline.length > 0
                ? pick(newline)
                : Math.floor(next() * content.length);
          if (at !== undefined && at > 0 && at < content.length) cuts.add(at);
        }
        cutSets.push([...cuts].sort((a, b) => a - b));
      }

      const { agentDir, file } = setup(name.replaceAll("/", "_"));
      for (const cuts of cutSets) {
        const catalog = new SessionCatalog({ agentDir });
        const bounds = [0, ...cuts, content.length];
        writeFileSync(file, "");
        for (let i = 1; i < bounds.length; i++) {
          appendFileSync(file, content.subarray(bounds[i - 1], bounds[i]));
          catalog.invalidate();
          const grown = await catalog.sessions();
          expect(grown, `${name} cut at ${cuts.join(",")}, piece ${i}`).toEqual(
            await fullParse(agentDir),
          );
        }
      }
    },
    15_000,
  );
});

describe("SessionCatalog appended lines", () => {
  const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
  const header = line({
    type: "session",
    version: 3,
    id: "s",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/p",
  });
  const user = (content: unknown, at: string) =>
    line({ type: "message", timestamp: at, message: { role: "user", content } });
  const assistant = (at: string) =>
    line({ type: "message", timestamp: at, message: { role: "assistant", content: "user" } });
  const info = (name: string | undefined, at: string) =>
    line({ type: "session_info", timestamp: at, ...(name === undefined ? {} : { name }) });

  it("keeps name, first message, last prompt and last update exact as the file grows", async () => {
    const { agentDir, file } = setup();
    const catalog = new SessionCatalog({ agentDir });
    const summary = async () => {
      catalog.invalidate();
      const [s] = await catalog.sessions();
      return s;
    };
    writeFileSync(file, header);
    expect(await summary()).toMatchObject({ id: "s", updatedAt: "2026-01-01T00:00:00.000Z" });

    // Attached files only: their names.
    appendFileSync(file, user('<file name="/x/a.ts">\nx\n</file>\n', "2026-01-01T00:00:01.000Z"));
    appendFileSync(file, info("First", "2026-01-01T00:00:02.000Z"));
    expect(await summary()).toMatchObject({
      name: "First",
      firstMessage: "(file: a.ts)",
      lastPromptAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
    });

    appendFileSync(file, user("second", "2026-01-01T00:00:03.000Z"));
    appendFileSync(file, assistant("2026-01-01T00:00:04.000Z"));
    // A line without a timestamp doesn't move the last update.
    appendFileSync(file, line({ type: "label" }));
    expect(await summary()).toMatchObject({
      name: "First",
      firstMessage: "(file: a.ts)",
      lastPromptAt: "2026-01-01T00:00:03.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
    });

    // A session_info without a name clears it.
    appendFileSync(file, info(undefined, "2026-01-01T00:00:05.000Z"));
    expect(await summary()).not.toHaveProperty("name");
    appendFileSync(file, info("  Last  ", "2026-01-01T00:00:06.000Z"));
    expect(await summary()).toMatchObject({ name: "Last" });
  });

  it("counts a complete last line without a newline, and a line once it's finished", async () => {
    const { agentDir, file } = setup();
    const catalog = new SessionCatalog({ agentDir });
    const summary = async () => {
      catalog.invalidate();
      const [s] = await catalog.sessions();
      return s;
    };
    const prompt = user("héllo wörld", "2026-01-01T00:00:01.000Z");
    writeFileSync(file, `${header}${prompt.slice(0, -1)}`);
    expect(await summary()).toMatchObject({ firstMessage: "héllo wörld" });

    writeFileSync(file, header);
    const bytes = Buffer.from(prompt);
    const cut = bytes.indexOf("ö") + 1; // inside the two bytes of "ö"
    appendFileSync(file, bytes.subarray(0, cut));
    expect(await summary()).not.toHaveProperty("firstMessage");
    appendFileSync(file, bytes.subarray(cut));
    expect(await summary()).toMatchObject({
      firstMessage: "héllo wörld",
      lastPromptAt: "2026-01-01T00:00:01.000Z",
    });
  });

  it("reads only the bytes appended since the last scan and the few before them", async () => {
    const { agentDir, file } = setup();
    const catalog = new SessionCatalog({ agentDir });
    writeFileSync(file, `${header}${user("one", "2026-01-01T00:00:01.000Z")}`);
    expect((await catalog.sessions())[0]).toMatchObject({ firstMessage: "one" });
    const size = statSync(file).size;

    const handle = await open(file, "r");
    const read = vi.spyOn(Object.getPrototypeOf(handle), "read");
    await handle.close();
    try {
      appendFileSync(file, user("two", "2026-01-01T00:00:02.000Z"));
      catalog.invalidate();
      expect((await catalog.sessions())[0]).toMatchObject({
        firstMessage: "one",
        lastPromptAt: "2026-01-01T00:00:02.000Z",
      });
      const offsets = read.mock.calls.map((call) => call[3] as number);
      expect(offsets.length).toBeGreaterThan(0);
      expect(Math.min(...offsets)).toBe(size - 64);
    } finally {
      read.mockRestore();
    }
  });

  it("reparses a file rewritten in place and grown, as pi's format migration does", async () => {
    const { agentDir, file } = setup();
    const catalog = new SessionCatalog({ agentDir });
    writeFileSync(file, `${header}${user("one", "2026-01-01T00:00:01.000Z")}`);
    expect((await catalog.sessions())[0]).toMatchObject({ firstMessage: "one" });

    // Same inode, truncated and written again, larger, with the earlier lines changed.
    writeFileSync(
      file,
      `${header}${user("ONE", "2026-01-01T00:00:01.000Z")}${user("two", "2026-01-01T00:00:02.000Z")}`,
    );
    catalog.invalidate();
    const sessions = await catalog.sessions();
    expect(sessions[0]).toMatchObject({
      firstMessage: "ONE",
      lastPromptAt: "2026-01-01T00:00:02.000Z",
    });
    expect(sessions).toEqual(await fullParse(agentDir));
  });

  it("reparses a file that shrank, was touched at the same size, or was replaced", async () => {
    const { agentDir, file } = setup();
    const catalog = new SessionCatalog({ agentDir });
    const summary = async () => {
      catalog.invalidate();
      const [s] = await catalog.sessions();
      return s;
    };
    writeFileSync(file, `${header}${user("one", "2026-01-01T00:00:01.000Z")}`);
    expect(await summary()).toMatchObject({ firstMessage: "one" });

    // Shrunk.
    writeFileSync(file, header);
    expect(await summary()).not.toHaveProperty("firstMessage");

    // Same size, different content and mtime.
    writeFileSync(file, `${header}${user("two", "2026-01-01T00:00:01.000Z")}`);
    expect(await summary()).toMatchObject({ firstMessage: "two" });
    writeFileSync(file, `${header}${user("TWO", "2026-01-01T00:00:01.000Z")}`);
    const later = new Date(statSync(file).mtimeMs + 5_000);
    utimesSync(file, later, later);
    expect(await summary()).toMatchObject({ firstMessage: "TWO" });

    // Replaced by a larger file (a new inode).
    const replacement = join(tmp, "replacement.jsonl");
    writeFileSync(
      replacement,
      `${header}${user("three", "2026-01-01T00:00:01.000Z")}${assistant("2026-01-01T00:00:02.000Z")}`,
    );
    renameSync(replacement, file);
    expect(await summary()).toMatchObject({
      firstMessage: "three",
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
  });
});
