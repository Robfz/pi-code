/**
 * Session catalog: read-only over pi's sessions dir (`<agentDir>/sessions/--<cwd>--/*.jsonl`,
 * docs/session-format.md); worktree removal deletes files through `session-files.ts`. Only header
 * `cwd`s are trusted; directory names are lossy.
 */
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type AgentId,
  type ProjectSummary,
  type RepoLayout,
  type SessionSummary,
  splitFileBlocks,
} from "@pi-code/protocol";
import { findGitDir } from "../git/branches.ts";
import { layoutOf } from "./layout.ts";

/** Longest `firstMessage`, in characters. */
export const FIRST_MESSAGE_MAX = 200;

/** How long a listing is reused before the sessions dir is scanned again. */
const LIST_TTL_MS = 1_000;
const PARSE_CONCURRENCY = 16;

/** What the file itself says (everything but `ownedBy` and `layout`). */
type ParsedSession = Omit<SessionSummary, "ownedBy" | "layout">;

/** A parsed session with its cwd's layout as of the scan that listed it. */
type ScannedSession = Omit<SessionSummary, "ownedBy">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLine(line: string): Record<string, unknown> | undefined {
  if (line.trim() === "") return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function validDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

/** Text of a user message's content: a string, or the text blocks of an array. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
}

/** Collapses whitespace and cuts to `FIRST_MESSAGE_MAX` characters (code points). */
function preview(text: string): string | undefined {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return undefined;
  const chars = Array.from(flat);
  if (chars.length <= FIRST_MESSAGE_MAX) return flat;
  return `${chars
    .slice(0, FIRST_MESSAGE_MAX - 1)
    .join("")
    .trimEnd()}…`;
}

/**
 * Summarizes one session file's content. Returns `undefined` when its first record isn't a
 * session header. Tolerates malformed lines and old format versions (v1 entries have no
 * `id`/`parentId`; v2 has the `hookMessage` role).
 */
export function parseSessionFile(
  file: string,
  content: string,
  fallbackTime: string,
): ParsedSession | undefined {
  let header: Record<string, unknown> | undefined;
  let name: string | undefined;
  let firstMessage: string | undefined;
  let headerLine = -1;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    // Once the first user message is known, only `session_info` lines matter.
    if (firstMessage !== undefined && !line.includes('"session_info"')) continue;
    const record = parseLine(line);
    if (record === undefined) continue;
    if (header === undefined) {
      if (record.type !== "session") return undefined;
      header = record;
      headerLine = i;
      continue;
    }
    if (record.type === "session_info") {
      name = typeof record.name === "string" ? record.name.trim() || undefined : undefined;
    } else if (
      firstMessage === undefined &&
      record.type === "message" &&
      isRecord(record.message) &&
      record.message.role === "user"
    ) {
      // Leading `<file>` blocks (attached text files) are left out; a message with nothing but
      // files shows their names.
      const { files, body } = splitFileBlocks(contentText(record.message.content));
      firstMessage =
        preview(body) ??
        (files.length > 0
          ? preview(`(file: ${files.map((f) => basename(f.name)).join(", ")})`)
          : undefined);
    }
  }
  if (header === undefined) return undefined;

  // The last entry's timestamp (skipping malformed or timestamp-less trailing lines).
  let lastTimestamp: string | undefined;
  for (let i = lines.length - 1; i > headerLine && lastTimestamp === undefined; i--) {
    lastTimestamp = validDate(parseLine(lines[i] as string)?.timestamp);
  }
  const createdAt = validDate(header.timestamp) ?? fallbackTime;
  const summary: ParsedSession = {
    file,
    id: typeof header.id === "string" && header.id !== "" ? header.id : idFromFileName(file),
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    createdAt,
    updatedAt: lastTimestamp ?? createdAt,
  };
  if (name !== undefined) summary.name = name;
  if (firstMessage !== undefined) summary.firstMessage = firstMessage;
  if (typeof header.parentSession === "string" && header.parentSession !== "") {
    summary.parentSession = header.parentSession;
  }
  return summary;
}

/** `<timestamp>_<id>.jsonl` → `<id>`. */
function idFromFileName(file: string): string {
  const base = basename(file, ".jsonl");
  const sep = base.indexOf("_");
  return sep >= 0 ? base.slice(sep + 1) : base;
}

/**
 * Reads the header of a session file: `{ cwd }` when the first record is a session header with
 * a cwd, else `undefined`.
 */
export async function readSessionHeader(
  file: string,
): Promise<{ id?: string; cwd: string } | undefined> {
  let content: string;
  try {
    const handle = await open(file, "r");
    try {
      // Headers are small; read a bounded prefix.
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      content = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
  for (const line of content.split("\n")) {
    const record = parseLine(line);
    if (record === undefined) continue;
    if (record.type !== "session" || typeof record.cwd !== "string" || record.cwd === "") {
      return undefined;
    }
    return typeof record.id === "string" ? { id: record.id, cwd: record.cwd } : { cwd: record.cwd };
  }
  return undefined;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: ParsedSession | undefined;
}

interface SessionCatalogDeps {
  /** pi's agent dir; sessions live in `<agentDir>/sessions`. */
  agentDir: string;
  /** The agent that has a session file open, if any. */
  ownerOf?: (sessionFile: string) => AgentId | undefined;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Session summaries and projects, cached per file by `(path, mtime, size)`. */
export class SessionCatalog {
  private readonly deps: SessionCatalogDeps;
  private readonly cache = new Map<string, CacheEntry>();
  private listing: { at: number; sessions: Promise<ScannedSession[]> } | undefined;
  private sessionsDir: Promise<string> | undefined;

  constructor(deps: SessionCatalogDeps) {
    this.deps = deps;
  }

  /**
   * All sessions, most recent first. `cwd` keeps those whose header `cwd` equals it; `q` those
   * whose `cwd` or `name` contains it, case-insensitively.
   */
  async sessions(filter: { cwd?: string; q?: string } = {}): Promise<SessionSummary[]> {
    const parsed = await this.scan();
    const owner = this.deps.ownerOf;
    const { cwd } = filter;
    const q = filter.q?.toLowerCase();
    return parsed
      .filter((s) => cwd === undefined || s.cwd === cwd)
      .filter(
        (s) =>
          q === undefined ||
          s.cwd.toLowerCase().includes(q) ||
          (s.name?.toLowerCase().includes(q) ?? false),
      )
      .map((s) => {
        const ownedBy = owner?.(s.file);
        return ownedBy === undefined ? { ...s } : { ...s, ownedBy };
      });
  }

  /** Distinct header cwds with session counts, most recent activity first. */
  async projects(): Promise<ProjectSummary[]> {
    const byCwd = new Map<
      string,
      { count: number; updatedAt: string; layout: RepoLayout | undefined }
    >();
    for (const s of await this.scan()) {
      if (s.cwd === "") continue;
      const p = byCwd.get(s.cwd);
      if (p === undefined) {
        byCwd.set(s.cwd, { count: 1, updatedAt: s.updatedAt, layout: s.layout });
      } else {
        p.count += 1;
        if (Date.parse(s.updatedAt) > Date.parse(p.updatedAt)) p.updatedAt = s.updatedAt;
      }
    }
    return [...byCwd.entries()]
      .map(([cwd, p]) => {
        const project: ProjectSummary = {
          cwd,
          sessionCount: p.count,
          updatedAt: p.updatedAt,
          isGitRepo: findGitDir(cwd) !== undefined,
        };
        if (p.layout !== undefined) project.layout = p.layout;
        return project;
      })
      .sort(byRecency);
  }

  /** Header cwds that have at least one session. */
  async sessionCwds(): Promise<Set<string>> {
    return new Set((await this.scan()).map((s) => s.cwd).filter((c) => c !== ""));
  }

  /** Drops the short-lived listing so the next call rescans (tests; after writes). */
  invalidate(): void {
    this.listing = undefined;
  }

  private scan(): Promise<ScannedSession[]> {
    const now = Date.now();
    if (this.listing === undefined || now - this.listing.at > LIST_TTL_MS) {
      const sessions = this.scanNow();
      this.listing = { at: now, sessions };
      sessions.catch(() => {
        if (this.listing?.sessions === sessions) this.listing = undefined;
      });
    }
    return this.listing.sessions;
  }

  /**
   * Lists and parses the session files, attaching each cwd's layout. Layouts are recomputed on
   * every scan: a folder's layout changes (e.g. a worktree deleted) without its files changing.
   */
  private async scanNow(): Promise<ScannedSession[]> {
    this.sessionsDir ??= realpath(join(this.deps.agentDir, "sessions")).catch(() =>
      join(this.deps.agentDir, "sessions"),
    );
    const root = await this.sessionsDir;
    let dirs: string[];
    try {
      dirs = (await readdir(root, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => join(root, d.name));
    } catch {
      return [];
    }
    // pi lists `<sessions>/<dir>/*.jsonl` only (deeper files belong to subagent runs).
    const files: string[] = [];
    await Promise.all(
      dirs.map(async (dir) => {
        try {
          for (const d of await readdir(dir, { withFileTypes: true })) {
            if (d.isFile() && d.name.endsWith(".jsonl")) files.push(join(dir, d.name));
          }
        } catch {
          // vanished or unreadable
        }
      }),
    );
    const seen = new Set(files);
    for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path);

    const summaries: ParsedSession[] = [];
    await mapLimit(files, PARSE_CONCURRENCY, async (file) => {
      const summary = await this.summarize(file);
      if (summary !== undefined) summaries.push(summary);
    });
    const layouts = new Map<string, RepoLayout | undefined>();
    for (const { cwd } of summaries) if (!layouts.has(cwd)) layouts.set(cwd, layoutOf(cwd));
    // Ties by file, so equal scans list sessions in the same order.
    return summaries
      .sort((a, b) => byRecency(a, b) || a.file.localeCompare(b.file))
      .map((s) => {
        const layout = layouts.get(s.cwd);
        return layout === undefined ? s : { ...s, layout };
      });
  }

  private async summarize(file: string): Promise<ParsedSession | undefined> {
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(file);
    } catch {
      this.cache.delete(file);
      return undefined;
    }
    const cached = this.cache.get(file);
    if (cached && cached.mtimeMs === s.mtimeMs && cached.size === s.size) return cached.summary;
    let summary: ParsedSession | undefined;
    try {
      summary = parseSessionFile(file, await readFile(file, "utf8"), s.mtime.toISOString());
    } catch {
      summary = undefined;
    }
    this.cache.set(file, { mtimeMs: s.mtimeMs, size: s.size, summary });
    return summary;
  }
}

function byRecency(a: { updatedAt: string }, b: { updatedAt: string }): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}
