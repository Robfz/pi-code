/**
 * Fake `pi --mode rpc`: replays a recorded fixture (see scripts/record-fixture.ts) over stdin/stdout.
 *
 *   node test/fake-pi.ts <fixture.jsonl> [--speed=0|1|N] [--delay-get-entries=MS]
 *
 * (Node 24 runs this file directly via type stripping; `tsx test/fake-pi.ts` works too.)
 *
 * Replay model:
 * - Recorded `in` lines are split into *gating* commands and *queries*.
 *   Gating commands (prompt, steer, abort, bash, compact, set_*, fork, extension_ui_response, …)
 *   gate the replay: the fake waits until the client sends a command of the same `type`
 *   (extension_ui_responses therefore match by order), then replays the `out`/`err` lines that
 *   follow, up to the next gating command. A response's recorded `id` (and a
 *   `bash_execution_update`'s) is rewritten to the id the client actually sent.
 * - Queries (`get_*`) never gate. Their recorded responses are dropped from the stream; instead the
 *   fake answers any query the client sends, at any time:
 *     - `get_entries [since]` from an entry list rebuilt from the recorded `get_entries`
 *       responses up to the current position (including the next recorded one in the current
 *       segment, so a sync right after `message_end` sees that entry, as with real pi), plus
 *       entries pi creates without any event (bash, compaction, labels, model changes, …) once
 *       the replay passes their creation time (estimated from entry timestamps);
 *     - other queries with the nearest recorded response of that command type.
 * - A gating command that doesn't match the next recorded one gets `success: false` and a note on
 *   stderr. Commands received while a segment is still replaying are queued.
 * - `--speed=0` (default) replays instantly, `1` with the recorded spacing, `N` N× faster.
 * - `--delay-get-entries=MS` answers `get_entries` MS milliseconds late (a slow pi), computed
 *   when the query arrives.
 * - `err` lines go to stderr. The process exits when stdin closes.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface FixtureLine {
  t: number;
  dir: "in" | "out" | "err";
  line: unknown;
}

type Rec = Record<string, unknown> & { type?: string; id?: string };

export const FAKE_PI_PATH = fileURLToPath(import.meta.url);
export const FIXTURES_DIR = join(dirname(FAKE_PI_PATH), "fixtures");

export function fixturePath(name: string): string {
  return name.includes("/") ? name : join(FIXTURES_DIR, `${name}.jsonl`);
}

export function loadFixture(path: string): FixtureLine[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as FixtureLine);
}

/** Spawns the fake pi on a fixture (name like "plain-answer", or a path). */
export function spawnFakePi(
  fixture: string,
  opts: {
    speed?: number;
    delayGetEntriesMs?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [FAKE_PI_PATH, ...fakePiArgs(fixture, opts)], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Arguments after the script path for a fake pi run. */
export function fakePiArgs(
  fixture: string,
  opts: { speed?: number; delayGetEntriesMs?: number } = {},
): string[] {
  const args = [fixturePath(fixture), `--speed=${opts.speed ?? 0}`];
  if (opts.delayGetEntriesMs) args.push(`--delay-get-entries=${opts.delayGetEntriesMs}`);
  return args;
}

const isQuery = (type: unknown) => typeof type === "string" && type.startsWith("get_");
const isObj = (v: unknown): v is Rec => typeof v === "object" && v !== null;

/** LF-only splitter over a UTF-8 byte stream (never readline: U+2028 is valid inside JSON). */
export function createLineSplitter(onLine: (line: string) => void) {
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  const emit = (line: string) => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  return {
    push(chunk: Uint8Array) {
      buf += decoder.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        emit(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    },
    end() {
      buf += decoder.decode();
      if (buf.length > 0) emit(buf);
      buf = "";
    },
  };
}

interface Segment {
  gate?: Rec; // undefined for the lines before the first gating command
  gateT: number;
  lines: number[]; // indexes of out/err lines to replay
  end: number; // fixture index where this segment ends (exclusive)
}

/**
 * Entries pi creates without an event (bash, compaction, labels, model / thinking changes,
 * branch summaries, startup entries) show up only in the next recorded `get_entries` response,
 * often a segment later than real pi has them. Estimate when each was created: the recorded
 * clock is aligned with entry timestamps through message entries, whose `message_end` line time
 * is known. Candidates are restricted to entries first seen in the session "epoch" they belong
 * to (a full `get_entries` that doesn't extend the previous list starts a new epoch), so entries
 * of a later session never leak into an earlier one.
 */
interface EventlessEntry {
  entry: Rec;
  epoch: number;
  createdT: number;
}

function eventlessEntries(fx: FixtureLine[], recordedQueries: Map<string, Rec>) {
  const messageEnds = new Set<string>();
  const messageEndT = new Map<string, number>();
  for (const l of fx) {
    if (l.dir !== "out" || !isObj(l.line) || l.line.type !== "message_end") continue;
    const m = l.line.message as Rec;
    const key = `${String(m.role)}:${String(m.timestamp)}`;
    messageEnds.add(key);
    messageEndT.set(key, l.t);
  }
  const keyOf = (e: Rec) =>
    e.type === "message" && isObj(e.message)
      ? `${String(e.message.role)}:${String(e.message.timestamp)}`
      : undefined;

  const epochByIndex = new Map<number, number>(); // fixture index of a response → epoch
  const firstSeen = new Map<string, { entry: Rec; epoch: number }>();
  let list: Rec[] = [];
  let epoch = 0;
  fx.forEach((l, i) => {
    const r = l.line;
    if (l.dir !== "out" || !isObj(r) || r.type !== "response" || r.command !== "get_entries") {
      return;
    }
    const req = typeof r.id === "string" ? recordedQueries.get(r.id) : undefined;
    if (!req || r.success !== true) return;
    const entries = (r.data as { entries: Rec[] }).entries;
    if (req.since === undefined) {
      if (!list.every((e, j) => entries[j]?.id === e.id)) epoch++;
      list = [...entries];
    } else {
      const known = new Set(list.map((e) => e.id));
      list.push(...entries.filter((e) => !known.has(e.id)));
    }
    epochByIndex.set(i, epoch);
    for (const e of entries) {
      if (typeof e.id === "string" && !firstSeen.has(e.id))
        firstSeen.set(e.id, { entry: e, epoch });
    }
  });

  let t0 = Number.NEGATIVE_INFINITY;
  for (const { entry } of firstSeen.values()) {
    const key = keyOf(entry);
    const t = key === undefined ? undefined : messageEndT.get(key);
    if (t !== undefined) t0 = Math.max(t0, Date.parse(String(entry.timestamp)) - t);
  }
  const candidates: EventlessEntry[] = [];
  if (Number.isFinite(t0)) {
    for (const { entry, epoch: ep } of firstSeen.values()) {
      const key = keyOf(entry);
      if (key !== undefined && messageEnds.has(key)) continue; // arrives with its message_end
      const createdT = Date.parse(String(entry.timestamp)) - t0;
      if (Number.isFinite(createdT)) candidates.push({ entry, epoch: ep, createdT });
    }
    candidates.sort((a, b) => a.createdT - b.createdT);
  }
  const createdTOf = (entry: Rec | undefined) =>
    entry === undefined ? Number.NEGATIVE_INFINITY : Date.parse(String(entry.timestamp)) - t0;
  return { epochByIndex, candidates, createdTOf };
}

function run(fixtureFile: string, speed: number, delayGetEntriesMs = 0) {
  const fx = loadFixture(fixtureFile);

  // Recorded query commands by id, so their responses can be recognised and dropped.
  const recordedQueries = new Map<string, Rec>();
  for (const l of fx) {
    if (l.dir === "in" && isObj(l.line) && isQuery(l.line.type) && typeof l.line.id === "string") {
      recordedQueries.set(l.line.id, l.line);
    }
  }
  const isRecordedQueryResponse = (r: unknown) =>
    isObj(r) && r.type === "response" && typeof r.id === "string" && recordedQueries.has(r.id);
  const eventless = eventlessEntries(fx, recordedQueries);

  // Segments between gating commands.
  const segments: Segment[] = [{ gateT: 0, lines: [], end: 0 }];
  fx.forEach((l, i) => {
    const cur = segments[segments.length - 1] as Segment;
    if (l.dir === "in") {
      if (isObj(l.line) && !isQuery(l.line.type)) {
        cur.end = i;
        segments.push({ gate: l.line, gateT: l.t, lines: [], end: fx.length });
      }
      return;
    }
    if (l.dir === "out" && isRecordedQueryResponse(l.line)) return;
    cur.lines.push(i);
  });
  (segments[segments.length - 1] as Segment).end = fx.length;

  const out = (rec: unknown) => {
    process.stdout.write(`${typeof rec === "string" ? rec : JSON.stringify(rec)}\n`);
  };
  const idMap = new Map<string, string | undefined>();
  const rewriteId = (rec: Rec): Rec => {
    if (
      (rec.type === "response" || rec.type === "bash_execution_update") &&
      typeof rec.id === "string"
    ) {
      if (idMap.has(rec.id)) {
        const copy = { ...rec };
        const actual = idMap.get(rec.id);
        if (actual === undefined) delete copy.id;
        else copy.id = actual;
        return copy;
      }
    }
    return rec;
  };

  // Replay position: index of the last emitted fixture line, and the current segment.
  let pos = -1;
  let segIdx = 0;

  /** Index up to which recorded query responses are "visible" for a query received now. */
  const visibleUpTo = (command: string): number => {
    const seg = segments[segIdx] as Segment;
    for (let i = pos + 1; i < seg.end; i++) {
      const l = fx[i] as FixtureLine;
      if (
        l.dir === "out" &&
        isRecordedQueryResponse(l.line) &&
        (l.line as Rec).command === command
      ) {
        return i;
      }
    }
    return pos;
  };

  const answerGetEntries = (cmd: Rec): Rec => {
    const upTo = visibleUpTo("get_entries");
    let entries: Rec[] = [];
    let leafId: unknown = null;
    let epoch = 0;
    for (let i = 0; i <= upTo && i < fx.length; i++) {
      const l = fx[i] as FixtureLine;
      if (l.dir !== "out" || !isObj(l.line) || l.line.command !== "get_entries") continue;
      if (!isRecordedQueryResponse(l.line) || l.line.success !== true) continue;
      const req = recordedQueries.get(l.line.id as string) as Rec;
      const data = l.line.data as { entries: Rec[]; leafId: unknown };
      if (req.since === undefined) entries = [...data.entries];
      else {
        const known = new Set(entries.map((e) => e.id));
        entries.push(...data.entries.filter((e) => !known.has(e.id)));
      }
      leafId = data.leafId;
      epoch = eventless.epochByIndex.get(i) ?? epoch;
    }
    // Event-less entries real pi already has at this point of the replay.
    const now = pos >= 0 ? (fx[pos] as FixtureLine).t : 0;
    const known = new Set(entries.map((e) => e.id));
    const extra = eventless.candidates.filter(
      (c) => c.epoch === epoch && c.createdT <= now && !known.has(c.entry.id),
    );
    if (extra.length > 0) {
      entries = [...entries, ...extra.map((c) => c.entry)];
      const last = extra[extra.length - 1] as EventlessEntry;
      const leaf = entries.find((e) => e.id === leafId);
      if (last.createdT >= eventless.createdTOf(leaf)) leafId = last.entry.id;
    }
    if (cmd.since !== undefined) {
      const at = entries.findIndex((e) => e.id === cmd.since);
      if (at < 0) {
        return {
          type: "response",
          command: "get_entries",
          success: false,
          error: `Entry not found: ${String(cmd.since)}`,
        };
      }
      entries = entries.slice(at + 1);
    }
    return { type: "response", command: "get_entries", success: true, data: { entries, leafId } };
  };

  const answerQuery = (cmd: Rec): Rec => {
    const type = cmd.type as string;
    if (type === "get_entries") return answerGetEntries(cmd);
    const upTo = visibleUpTo(type);
    let best: Rec | undefined;
    let firstLater: Rec | undefined;
    fx.forEach((l, i) => {
      if (l.dir !== "out" || !isRecordedQueryResponse(l.line) || (l.line as Rec).command !== type)
        return;
      if (i <= upTo) best = l.line as Rec;
      else firstLater ??= l.line as Rec;
    });
    const found = best ?? firstLater;
    if (!found) {
      return {
        type: "response",
        command: type,
        success: false,
        error: `fake-pi: no recorded response for ${type}`,
      };
    }
    const { id: _id, ...rest } = found;
    return rest;
  };

  const withId = (resp: Rec, cmd: Rec): Rec =>
    typeof cmd.id === "string" ? { id: cmd.id, ...resp } : resp;

  // Replaying a segment (async when speed > 0).
  let replaying = false;
  const queue: Rec[] = [];
  let stdinClosed = false;

  // process.exit() can drop buffered stdout on pipes (async on macOS): exit once it is flushed.
  const flushAndExit = () => process.stdout.write("", () => process.exit(0));

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const replaySegment = async (seg: Segment) => {
    const startWall = Date.now();
    for (const i of seg.lines) {
      if (stdinClosed) return;
      const l = fx[i] as FixtureLine;
      if (speed > 0) {
        const due = startWall + Math.max(0, l.t - seg.gateT) / speed;
        const wait = due - Date.now();
        if (wait > 0) await sleep(wait);
      }
      if (l.dir === "err") process.stderr.write(`${String(l.line)}\n`);
      else out(isObj(l.line) ? rewriteId(l.line) : l.line);
      pos = i;
    }
    pos = Math.max(pos, seg.end - 1);
  };

  const pump = async () => {
    if (replaying) return;
    replaying = true;
    try {
      while (queue.length > 0) {
        const cmd = queue.shift() as Rec;
        const next = segments[segIdx + 1];
        if (next?.gate && next.gate.type === cmd.type) {
          if (typeof next.gate.id === "string")
            idMap.set(next.gate.id, cmd.id as string | undefined);
          segIdx++;
          await replaySegment(next);
        } else if (cmd.type !== "extension_ui_response") {
          const expected = next?.gate ? String(next.gate.type) : "(end of fixture)";
          process.stderr.write(
            `[fake-pi] unexpected command ${String(cmd.type)}; expected ${expected}\n`,
          );
          out(
            withId(
              {
                type: "response",
                command: cmd.type,
                success: false,
                error: `fake-pi: unexpected command (expected ${expected})`,
              },
              cmd,
            ),
          );
        } else {
          process.stderr.write("[fake-pi] unexpected extension_ui_response ignored\n");
        }
      }
    } finally {
      replaying = false;
    }
    if (stdinClosed) flushAndExit();
  };

  const onLine = (line: string) => {
    if (line.trim().length === 0) return;
    let cmd: Rec;
    try {
      cmd = JSON.parse(line) as Rec;
    } catch (e) {
      out({
        type: "response",
        command: "parse",
        success: false,
        error: `Failed to parse command: ${(e as Error).message}`,
      });
      return;
    }
    if (isQuery(cmd.type)) {
      const response = withId(answerQuery(cmd), cmd);
      if (cmd.type === "get_entries" && delayGetEntriesMs > 0) {
        setTimeout(() => out(response), delayGetEntriesMs);
      } else {
        out(response);
      }
      return;
    }
    queue.push(cmd);
    void pump();
  };

  const splitter = createLineSplitter(onLine);
  process.stdin.on("data", (c: Buffer) => splitter.push(c));
  process.stdin.on("end", () => {
    splitter.end();
    stdinClosed = true;
    queue.length = 0; // like pi: stop working once stdin is gone
    if (!replaying) flushAndExit();
  });

  // Lines recorded before the first gating command (usually none).
  replaying = true;
  void replaySegment(segments[0] as Segment).then(() => {
    replaying = false;
    void pump();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const speedArg = args.find((a) => a.startsWith("--speed="));
  const delayArg = args.find((a) => a.startsWith("--delay-get-entries="));
  if (!file) {
    process.stderr.write(
      "usage: fake-pi.ts <fixture.jsonl> [--speed=0|1|N] [--delay-get-entries=MS]\n",
    );
    process.exit(2);
  }
  run(
    file,
    speedArg ? Number(speedArg.slice("--speed=".length)) : 0,
    delayArg ? Number(delayArg.slice("--delay-get-entries=".length)) : 0,
  );
}
