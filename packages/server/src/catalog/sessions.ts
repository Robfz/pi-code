/**
 * Session catalog: read-only over pi's sessions dir (`<agentDir>/sessions/--<cwd>--/*.jsonl`,
 * docs/session-format.md); session deletion and worktree removal delete listed files through
 * `session-files.ts`. Only header `cwd`s are trusted; directory names are lossy.
 */
import { type FileHandle, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type AgentId,
  compareRecency,
  type ProjectSummary,
  recencyOf,
  type SessionSummary,
  splitFileBlocks,
} from "@pi-code/protocol";
import { findGitDir } from "../git/branches.ts";
import { isDirectory, layoutOf } from "./layout.ts";

/** Longest `firstMessage`, in characters. */
export const FIRST_MESSAGE_MAX = 200;

/** How long a listing is reused before the sessions dir is scanned again. */
const LIST_TTL_MS = 1_000;
const PARSE_CONCURRENCY = 16;

/** What the file itself says (everything but `ownedBy`, `layout` and `missing`). */
type ParsedSession = Omit<SessionSummary, "ownedBy" | "layout" | "missing">;

/** A parsed session with its cwd's layout and presence as of the scan that listed it. */
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
 * What a session file's lines say so far. pi appends to session files, so the lines read so far
 * fold into this and later lines fold on top (`foldLines`), giving the same summary as parsing
 * the whole file at once.
 */
interface ParseState {
  /** The header record, once found. */
  header?: Record<string, unknown>;
  /** The first record isn't a session header: not a session file, whatever follows. */
  notSession?: true;
  /** From the last `session_info` line; one without a name clears it. */
  name?: string;
  firstMessage?: string;
  /** Of the last line after the header with a valid timestamp. */
  lastTimestamp?: string;
  /** Of the last user message after the header with a valid timestamp. */
  lastPromptAt?: string;
}

/**
 * Folds `lines` (complete lines following those `state` saw, in file order) into a new state.
 * Tolerates malformed lines and old format versions (v1 entries have no `id`/`parentId`; v2 has
 * the `hookMessage` role).
 */
function foldLines(state: ParseState, lines: string[]): ParseState {
  if (state.notSession) return state;
  const next: ParseState = { ...state };
  // Index of the first of `lines` after the header.
  let afterHeader = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    // Once the first user message is known, only `session_info` lines matter.
    if (next.firstMessage !== undefined && !line.includes('"session_info"')) continue;
    const record = parseLine(line);
    if (record === undefined) continue;
    if (next.header === undefined) {
      if (record.type !== "session") return { notSession: true };
      next.header = record;
      afterHeader = i + 1;
      continue;
    }
    if (record.type === "session_info") {
      next.name = typeof record.name === "string" ? record.name.trim() || undefined : undefined;
    } else if (
      next.firstMessage === undefined &&
      record.type === "message" &&
      isRecord(record.message) &&
      record.message.role === "user"
    ) {
      // Leading `<file>` blocks (attached text files) are left out; a message with nothing but
      // files shows their names.
      const { files, body } = splitFileBlocks(contentText(record.message.content));
      next.firstMessage =
        preview(body) ??
        (files.length > 0
          ? preview(`(file: ${files.map((f) => basename(f.name)).join(", ")})`)
          : undefined);
    }
  }
  if (next.header === undefined) return next;
  // Both scan from the end: only the last match counts, and it is usually near the end.
  for (let i = lines.length - 1; i >= afterHeader; i--) {
    const at = validDate(parseLine(lines[i] as string)?.timestamp);
    if (at !== undefined) {
      next.lastTimestamp = at;
      break;
    }
  }
  const lastPromptAt = lastUserMessageTime(lines, afterHeader);
  if (lastPromptAt !== undefined) next.lastPromptAt = lastPromptAt;
  return next;
}

/** The summary a parse state gives; `undefined` without a session header. */
function summaryOf(
  file: string,
  state: ParseState,
  fallbackTime: string,
): ParsedSession | undefined {
  const { header } = state;
  if (header === undefined) return undefined;
  const createdAt = validDate(header.timestamp) ?? fallbackTime;
  const summary: ParsedSession = {
    file,
    id: typeof header.id === "string" && header.id !== "" ? header.id : idFromFileName(file),
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    createdAt,
    updatedAt: state.lastTimestamp ?? createdAt,
  };
  if (state.lastPromptAt !== undefined) summary.lastPromptAt = state.lastPromptAt;
  if (state.name !== undefined) summary.name = state.name;
  if (state.firstMessage !== undefined) summary.firstMessage = state.firstMessage;
  if (typeof header.parentSession === "string" && header.parentSession !== "") {
    summary.parentSession = header.parentSession;
  }
  return summary;
}

/**
 * Summarizes one session file's content. Returns `undefined` when its first record isn't a
 * session header.
 */
export function parseSessionFile(
  file: string,
  content: string,
  fallbackTime: string,
): ParsedSession | undefined {
  return summaryOf(file, foldLines({}, content.split("\n")), fallbackTime);
}

/** The timestamp of the last user message entry from `lines[from]` on, scanning from the end. */
function lastUserMessageTime(lines: string[], from: number): string | undefined {
  for (let i = lines.length - 1; i >= from; i--) {
    const line = lines[i] as string;
    if (!line.includes('"user"')) continue;
    const record = parseLine(line);
    if (record?.type === "message" && isRecord(record.message) && record.message.role === "user") {
      const at = validDate(record.timestamp);
      if (at !== undefined) return at;
    }
  }
  return undefined;
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

/** A session file as of its last read. */
interface CacheEntry {
  ino: number;
  mtimeMs: number;
  /** Bytes read. */
  size: number;
  summary: ParsedSession | undefined;
  /**
   * The state after the complete lines read, the bytes after the last newline (a line still
   * being written), and the last bytes read (`FINGERPRINT_BYTES` at most). Absent when the read
   * failed.
   */
  parsed?: { state: ParseState; tail: Buffer; fingerprint: Buffer };
}

/**
 * How many of the last bytes read are compared before resuming a grown file. pi rewrites a file
 * in place (same inode, truncated, usually larger) when it migrates an old format; the migrated
 * records differ from the old ones, so the bytes before the resume offset change too.
 */
const FINGERPRINT_BYTES = 64;

/** Bytes `[start, end)` of an open file, fewer if it ends sooner. */
async function readRange(handle: FileHandle, start: number, end: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(end - start);
  let read = 0;
  while (read < buf.length) {
    const { bytesRead } = await handle.read(buf, read, buf.length - read, start + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return buf.subarray(0, read);
}

/** Where a read continues: an offset, and what the bytes before it left. */
interface ResumePoint {
  from: number;
  state: ParseState;
  tail: Buffer;
  /** The last bytes before `from` (the cached fingerprint). */
  before: Buffer;
}

const START: ResumePoint = { from: 0, state: {}, tail: Buffer.alloc(0), before: Buffer.alloc(0) };

/**
 * Where to continue reading a file the cache read before: after the bytes read, when the file is
 * the same inode, grew, and still has the fingerprint's bytes right before them; else `undefined`.
 */
async function resumeRead(
  handle: FileHandle,
  cached: CacheEntry | undefined,
  current: { ino: number; size: number },
): Promise<ResumePoint | undefined> {
  if (cached?.parsed === undefined || cached.ino !== current.ino || current.size <= cached.size) {
    return undefined;
  }
  const { state, tail, fingerprint } = cached.parsed;
  const before = await readRange(handle, cached.size - fingerprint.length, cached.size);
  if (!before.equals(fingerprint)) return undefined;
  return { from: cached.size, state, tail, before };
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

/** Session summaries and projects, cached per file and parsed incrementally as files grow. */
export class SessionCatalog {
  private readonly deps: SessionCatalogDeps;
  private readonly cache = new Map<string, CacheEntry>();
  private listing: { at: number; sessions: Promise<ScannedSession[]> } | undefined;
  private sessionsDir: Promise<string> | undefined;

  constructor(deps: SessionCatalogDeps) {
    this.deps = deps;
  }

  /**
   * All sessions, most recently prompted first (`compareRecency`). `cwd` keeps those whose header `cwd` equals it; `q` those
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

  /** Distinct header cwds with session counts, most recently prompted first (`compareRecency`). */
  async projects(): Promise<ProjectSummary[]> {
    const byCwd = new Map<string, ProjectSummary>();
    for (const s of await this.scan()) {
      if (s.cwd === "") continue;
      const p = byCwd.get(s.cwd);
      if (p === undefined) {
        const project: ProjectSummary = {
          cwd: s.cwd,
          sessionCount: 1,
          createdAt: s.createdAt,
          isGitRepo: false,
        };
        if (s.lastPromptAt !== undefined) project.lastPromptAt = s.lastPromptAt;
        if (s.layout !== undefined) project.layout = s.layout;
        byCwd.set(s.cwd, project);
      } else {
        p.sessionCount += 1;
        if (Date.parse(s.createdAt) > Date.parse(p.createdAt)) p.createdAt = s.createdAt;
        if (
          s.lastPromptAt !== undefined &&
          (p.lastPromptAt === undefined || Date.parse(s.lastPromptAt) > Date.parse(p.lastPromptAt))
        ) {
          p.lastPromptAt = s.lastPromptAt;
        }
      }
    }
    return [...byCwd.values()]
      .map((project) => ({ ...project, isGitRepo: findGitDir(project.cwd) !== undefined }))
      .sort((a, b) => compareRecency(recencyOf(a), recencyOf(b)) || a.cwd.localeCompare(b.cwd));
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
   * Lists and parses the session files, attaching each cwd's layout and whether it is gone.
   * Both are recomputed on every scan: a folder changes (e.g. gets deleted) without its session
   * files changing.
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
    const folders = new Map<string, Pick<ScannedSession, "layout" | "missing">>();
    for (const { cwd } of summaries) {
      if (folders.has(cwd)) continue;
      const layout = layoutOf(cwd);
      folders.set(cwd, {
        ...(layout === undefined ? {} : { layout }),
        ...(isDirectory(cwd) ? {} : { missing: true }),
      });
    }
    // Ties by file, so equal scans list sessions in the same order.
    return summaries
      .sort((a, b) => compareRecency(recencyOf(a), recencyOf(b)) || a.file.localeCompare(b.file))
      .map((s) => ({ ...s, ...folders.get(s.cwd) }));
  }

  /**
   * Summarizes a file, reading only what changed since the cached read: nothing when its
   * `(inode, mtime, size)` is unchanged, the appended bytes when it grew and still has the bytes
   * last read before them, and the whole file otherwise (shrunk, rewritten, replaced).
   */
  private async summarize(file: string): Promise<ParsedSession | undefined> {
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(file);
    } catch {
      this.cache.delete(file);
      return undefined;
    }
    const cached = this.cache.get(file);
    if (cached?.ino === s.ino && cached.mtimeMs === s.mtimeMs && cached.size === s.size) {
      return cached.summary;
    }
    let entry: CacheEntry;
    try {
      const handle = await open(file, "r");
      try {
        // The open file's own stat, so a file replaced since `stat` isn't resumed.
        const current = await handle.stat();
        const resume = (await resumeRead(handle, cached, current)) ?? START;
        const bytes = await readRange(handle, resume.from, current.size);
        const chunk = resume.tail.length === 0 ? bytes : Buffer.concat([resume.tail, bytes]);
        const end = chunk.lastIndexOf(0x0a);
        // Newline bytes never occur inside a multi-byte UTF-8 sequence, so lines decode alone.
        const state =
          end < 0
            ? resume.state
            : foldLines(resume.state, chunk.toString("utf8", 0, end).split("\n"));
        const tail = Buffer.from(chunk.subarray(end + 1));
        // As in a full parse, an unfinished last line counts if it parses; it is folded for good
        // once its newline arrives.
        const summary = summaryOf(
          file,
          foldLines(state, [tail.toString("utf8")]),
          current.mtime.toISOString(),
        );
        const last =
          bytes.length >= FINGERPRINT_BYTES ? bytes : Buffer.concat([resume.before, bytes]);
        entry = {
          ino: current.ino,
          mtimeMs: current.mtimeMs,
          size: resume.from + bytes.length,
          summary,
          parsed: {
            state,
            tail,
            fingerprint: Buffer.from(last.subarray(Math.max(0, last.length - FINGERPRINT_BYTES))),
          },
        };
      } finally {
        await handle.close();
      }
    } catch {
      entry = { ino: s.ino, mtimeMs: s.mtimeMs, size: s.size, summary: undefined };
    }
    // A new entry rather than an update, so concurrent scans of one file don't fold twice.
    this.cache.set(file, entry);
    return entry.summary;
  }
}
