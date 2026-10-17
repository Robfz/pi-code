/**
 * Generated fake-pi fixtures (`test/fake-pi.ts` replays them): the recorded format of
 * `test/fixtures/*.jsonl`, modelled on `plain-answer` (thinking + text), `tool-calls` (sequential
 * tool turns, `edit` with `details.diff`) and the trailing queries every recording ends with.
 *
 * Every kind but `history` waits for one `prompt`, then replays a run. `history` has no gate: the
 * fake serves its entries from the start, as a resumed session's transcript.
 */
import { writeFileSync } from "node:fs";
import type { FixtureLine } from "../../../test/fake-pi.ts";

export type FixtureKind = "short-answer" | "long-stream" | "tool-storm" | "history";

export interface FixtureOptions {
  /** The project dir (the system prompt's `cwd` section). */
  cwd: string;
  /** Reported by `get_state` / `get_session_stats`: the session the agent has open. */
  sessionFile: string;
  sessionId: string;
  /** The user message of the run (or of the history). */
  prompt: string;
}

type Rec = Record<string, unknown>;

interface Entry extends Rec {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

type Part =
  | { kind: "thinking"; deltas: string[] }
  | { kind: "text"; deltas: string[] }
  | { kind: "toolCall"; id: string; name: string; args: Rec };

const BASE = Date.parse("2026-01-01T10:00:00.000Z");
const MODEL = { api: "anthropic-messages", provider: "anthropic", model: "claude-haiku-4-5" };
const USAGE = {
  input: 12,
  output: 48,
  cacheRead: 9200,
  cacheWrite: 180,
  totalTokens: 9440,
  cost: {
    input: 0.000012,
    output: 0.00024,
    cacheRead: 0.00092,
    cacheWrite: 0.000225,
    total: 0.0014,
  },
  cacheWrite1h: 0,
};
const DELTA_MS = 25;

/** mulberry32: deterministic pseudo-random numbers in [0, 1). */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Splits `text` into model-like tokens of 4 to 6 characters. */
function tokenize(text: string, seed: number): string[] {
  const next = random(seed);
  const out: string[] = [];
  for (let i = 0; i < text.length; ) {
    const size = 4 + Math.floor(next() * 3);
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

/** Writes the records of one pi process: a running clock, entry ids and recorded queries. */
class Recorder {
  readonly lines: FixtureLine[] = [];
  /** The session's entries, in order (one linear branch). */
  readonly entries: Entry[] = [];
  /** Every message of the run (`agent_end.messages`). */
  readonly messages: Rec[] = [];
  t = 0;
  private commands = 0;
  private entryCount = 0;
  private toolCount = 0;

  advance(ms: number): void {
    this.t += ms;
  }

  in(line: Rec): void {
    this.lines.push({ t: this.t, dir: "in", line });
  }

  out(line: Rec): void {
    this.lines.push({ t: this.t, dir: "out", line });
  }

  command(type: string, fields: Rec = {}): string {
    const id = `e2e-${++this.commands}`;
    this.in({ id, type, ...fields });
    return id;
  }

  respond(id: string, command: string, data?: unknown): void {
    this.out({
      id,
      type: "response",
      command,
      success: true,
      ...(data === undefined ? {} : { data }),
    });
  }

  now(): number {
    return BASE + this.t;
  }

  toolId(): string {
    return `toolu_e2e_${String(++this.toolCount).padStart(4, "0")}`;
  }

  entry(fields: Rec & { type: string }): Entry {
    const entry: Entry = {
      id: `e${(++this.entryCount).toString(16).padStart(7, "0")}`,
      parentId: this.entries.at(-1)?.id ?? null,
      timestamp: new Date(this.now()).toISOString(),
      ...fields,
    };
    this.entries.push(entry);
    return entry;
  }

  /** `get_entries { since: <leaf before> }` and its answer, as the server sends after `message_end`. */
  syncSince(since: string, fresh: Entry[]): void {
    const id = this.command("get_entries", { since });
    this.respond(id, "get_entries", { entries: fresh, leafId: this.entries.at(-1)?.id ?? null });
  }

  /** A whole (non-streamed) message after the first: start, end, its entry and the entry sync. */
  message(message: Rec): void {
    const since = this.entries.at(-1)?.id as string;
    this.out({ type: "message_start", message });
    this.out({ type: "message_end", message });
    this.messages.push(message);
    this.syncSince(since, [this.entry({ type: "message", message })]);
  }

  /** Streams an assistant message part by part; `gap(i)` is the delay before the i-th delta. */
  assistant(parts: Part[], stopReason: "stop" | "toolUse", gap: (i: number) => number): Rec {
    const timestamp = this.now();
    this.out({
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        ...MODEL,
        usage: USAGE,
        stopReason: "pending",
        timestamp,
      },
    });
    const update = (event: Rec) =>
      this.out({ type: "message_update", usage: USAGE, assistantMessageEvent: event });
    const content: Rec[] = [];
    let delta = 0;
    parts.forEach((part, contentIndex) => {
      if (part.kind === "toolCall") {
        const args = JSON.stringify(part.args);
        update({ type: "toolcall_start", contentIndex, id: part.id, toolName: part.name });
        this.advance(10);
        update({ type: "toolcall_delta", contentIndex, delta: args });
        this.advance(10);
        const toolCall = { type: "toolCall", id: part.id, name: part.name, arguments: part.args };
        update({ type: "toolcall_end", contentIndex, toolCall });
        content.push(toolCall);
        return;
      }
      update({ type: `${part.kind}_start`, contentIndex });
      for (const text of part.deltas) {
        this.advance(gap(delta++));
        update({ type: `${part.kind}_delta`, contentIndex, delta: text });
      }
      const full = part.deltas.join("");
      update({ type: `${part.kind}_end`, contentIndex, content: full });
      content.push(
        part.kind === "thinking"
          ? { type: "thinking", thinking: full }
          : { type: "text", text: full },
      );
    });
    this.advance(5);
    const message = {
      role: "assistant",
      content,
      ...MODEL,
      usage: USAGE,
      stopReason,
      timestamp,
      responseId: `msg_e2e_${timestamp}`,
      responseModel: "claude-haiku-4-5-20251001",
      rawStopReason: stopReason === "stop" ? "end_turn" : "tool_use",
    };
    const since = this.entries.at(-1)?.id as string;
    this.out({ type: "message_end", message });
    this.messages.push(message);
    this.syncSince(since, [this.entry({ type: "message", message })]);
    return message;
  }

  /** Runs a streamed tool call to its result message. */
  tool(call: Extract<Part, { kind: "toolCall" }>, result: Rec): Rec {
    this.advance(5);
    this.out({
      type: "tool_execution_start",
      toolCallId: call.id,
      toolName: call.name,
      args: call.args,
    });
    this.advance(30);
    this.out({
      type: "tool_execution_end",
      toolCallId: call.id,
      toolName: call.name,
      result,
      isError: false,
    });
    const message = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      ...result,
      isError: false,
      timestamp: this.now(),
    };
    this.message(message);
    return message;
  }

  /** The start of a run: the prompt, `agent_start`, the system and user messages and their sync. */
  startRun(opts: FixtureOptions): void {
    const prompt = this.command("prompt", { message: opts.prompt });
    this.advance(400);
    this.respond(prompt, "prompt");
    this.out({ type: "agent_start" });
    this.out({ type: "turn_start" });
    const system = systemMessage(opts.cwd, this.now());
    this.out({ type: "message_start", message: system });
    this.out({ type: "message_end", message: system });
    this.messages.push(system);
    const full = this.command("get_entries");
    this.entry({ type: "model_change", provider: "anthropic", modelId: "claude-haiku-4-5" });
    this.entry({ type: "thinking_level_change", thinkingLevel: "low" });
    this.entry({ type: "message", message: system });
    const user = userMessage(opts.prompt, this.now());
    this.out({ type: "message_start", message: user });
    this.out({ type: "message_end", message: user });
    this.messages.push(user);
    const userEntry = this.entry({ type: "message", message: user });
    this.advance(20);
    this.respond(full, "get_entries", { entries: [...this.entries], leafId: userEntry.id });
    this.syncSince(userEntry.id, []);
  }

  turnEnd(message: Rec, toolResults: Rec[], more: boolean): void {
    this.advance(10);
    this.out({ type: "turn_end", message, toolResults });
    if (more) {
      this.advance(10);
      this.out({ type: "turn_start" });
    }
  }

  endRun(): void {
    this.out({ type: "agent_end", messages: this.messages, willRetry: false });
    this.out({ type: "agent_settled" });
  }

  /** The queries every recording ends with. */
  trailer(opts: FixtureOptions): void {
    this.advance(1000);
    const messages = this.entries.filter((e) => e.type === "message").map((e) => e.message as Rec);
    const count = (role: string) => messages.filter((m) => m.role === role).length;
    const toolCalls = messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content as Rec[])
      .filter((c) => c.type === "toolCall").length;
    const state = this.command("get_state");
    this.respond(state, "get_state", {
      model: {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5 (latest)",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
        contextWindow: 200000,
        maxTokens: 64000,
        type: "chat",
      },
      thinkingLevel: "low",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      sessionFile: opts.sessionFile,
      sessionId: opts.sessionId,
      autoCompactionEnabled: true,
      messageCount: messages.length,
      pendingMessageCount: 0,
    });
    const entries = this.command("get_entries");
    this.respond(entries, "get_entries", {
      entries: [...this.entries],
      leafId: this.entries.at(-1)?.id ?? null,
    });
    const stats = this.command("get_session_stats");
    this.respond(stats, "get_session_stats", {
      sessionFile: opts.sessionFile,
      sessionId: opts.sessionId,
      userMessages: count("user"),
      assistantMessages: count("assistant"),
      toolCalls,
      toolResults: count("toolResult"),
      totalMessages: messages.length,
      tokens: { input: 120, output: 4800, cacheRead: 92000, cacheWrite: 1800, total: 98720 },
      cost: 0.0421,
      contextUsage: { tokens: 9440, contextWindow: 200000, percent: 4.72 },
    });
  }
}

function systemMessage(cwd: string, timestamp: number): Rec {
  return {
    role: "system",
    content: "",
    sections: {
      preamble:
        "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
      cwd: `<cwd>\n${cwd}\n</cwd>`,
    },
    timestamp,
  };
}

function userMessage(text: string, timestamp: number): Rec {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

const THINKING = ["The user wants", " a clear answer.", " Let me write it."];

// ---------------------------------------------------------------------------
// short-answer

const SHORT_TEXT =
  "Sure. The fake pi replays this answer token by token, so the browser sees a real stream of text deltas ending in one committed message.";

export const SHORT_ANSWER = { text: SHORT_TEXT };

function shortAnswer(r: Recorder): void {
  const message = r.assistant(
    [
      { kind: "thinking", deltas: THINKING },
      { kind: "text", deltas: tokenize(SHORT_TEXT, 1) },
    ],
    "stop",
    () => DELTA_MS,
  );
  r.turnEnd(message, [], false);
}

// ---------------------------------------------------------------------------
// long-stream

const WORDS =
  "the stream renders each delta into markdown while the transcript keeps its scroll pinned to the bottom so a long reply stays readable as code blocks headings and references arrive in small pieces from the agent process through the server and the event source".split(
    " ",
  );

const REFS = ["@src/app.ts:12", "@src/lib/util.ts:40-52", "@README.md:3"] as const;

const SECTIONS = [
  {
    title: "Server entry point",
    lang: "ts",
    code: [
      'import { serve } from "@hono/node-server";',
      'import { app } from "./app.ts";',
      "",
      "const port = Number(process.env.PORT ?? 4180);",
      "serve({ fetch: app.fetch, port }, (info) => {",
      '  console.log("listening on", info.port);',
      "});",
      "",
      "export function shutdown(signal: string): void {",
      '  console.log(signal, "closing");',
      "  process.exit(0);",
      "}",
    ],
  },
  {
    title: "Configuration",
    lang: "json",
    code: [
      "{",
      '  "name": "example",',
      '  "version": "1.0.0",',
      '  "type": "module",',
      '  "scripts": {',
      '    "build": "vite build",',
      '    "test": "vitest run"',
      "  },",
      '  "engines": { "node": ">=24" }',
      "}",
    ],
  },
  {
    title: "Running it",
    lang: "bash",
    code: [
      "set -euo pipefail",
      "pnpm install",
      "pnpm build",
      "for port in 4180 4181; do",
      '  lsof -ti "tcp:$port" | xargs -r kill',
      "done",
      "NODE_ENV=production pnpm start > server.log 2>&1 &",
      'echo "started $!"',
    ],
  },
  {
    title: "A helper script",
    lang: "python",
    code: [
      "import json",
      "from pathlib import Path",
      "",
      "",
      "def load(path: Path) -> list[dict]:",
      '    """Reads one JSON object per line."""',
      "    with path.open() as f:",
      "        return [json.loads(line) for line in f if line.strip()]",
      "",
      "",
      'if __name__ == "__main__":',
      '    print(len(load(Path("events.jsonl"))))',
    ],
  },
  {
    title: "Styles",
    lang: "css",
    code: [
      ".transcript {",
      "  display: flex;",
      "  flex-direction: column;",
      "  gap: 1rem;",
      "  overflow-y: auto;",
      "}",
      "",
      ".transcript pre {",
      "  border-radius: 0.5rem;",
      "  font-family: var(--font-mono);",
      "}",
    ],
  },
  {
    title: "The change",
    lang: "diff",
    code: [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -10,7 +10,8 @@",
      " export function start() {",
      "-  const port = 4180;",
      "+  const port = Number(process.env.PORT ?? 4180);",
      '+  const host = "127.0.0.1";',
      "   return listen(port);",
      " }",
    ],
  },
] as const;

function prose(next: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    const word = WORDS[Math.floor(next() * WORDS.length)] as string;
    const sentenceStart = i % 14 === 0;
    const sentenceEnd = i % 14 === 13 || i === words - 1;
    out.push(
      `${sentenceStart ? word.charAt(0).toUpperCase() + word.slice(1) : word}${sentenceEnd ? "." : ""}`,
    );
  }
  return out.join(" ");
}

/** The reply's markdown blocks: per section a heading, prose, a fenced block and more prose. */
function longBlocks(): string[] {
  const next = random(7);
  return SECTIONS.flatMap((section, i) => {
    const ref = i % 2 === 0 ? ` See ${REFS[i / 2]} for the details.` : "";
    return [
      `## ${section.title}`,
      `${prose(next, 100)}${ref}`,
      `\`\`\`${section.lang}\n${section.code.join("\n")}\n\`\`\``,
      prose(next, 30),
    ];
  });
}

const LONG_BLOCKS = longBlocks();
const LONG_TEXT = `${LONG_BLOCKS.join("\n\n")}\n`;
const LONG_DELTAS = tokenize(LONG_TEXT, 3);

export const LONG_STREAM = {
  text: LONG_TEXT,
  /** `text` is these joined by blank lines: each renders as one top-level block. */
  blocks: LONG_BLOCKS,
  headings: SECTIONS.map((s) => s.title),
  codeBlocks: SECTIONS.length,
  languages: SECTIONS.map((s) => s.lang),
  refs: [...REFS],
};

function longStream(r: Recorder): void {
  // Like a real model, deltas sometimes arrive in bursts: every tenth group of three shares a time.
  const gap = (i: number) => (i % 30 === 1 || i % 30 === 2 ? 0 : DELTA_MS);
  const message = r.assistant(
    [
      { kind: "thinking", deltas: THINKING },
      { kind: "text", deltas: LONG_DELTAS },
    ],
    "stop",
    gap,
  );
  r.turnEnd(message, [], false);
}

// ---------------------------------------------------------------------------
// tool-storm

const BLOCK = [
  "read",
  "read",
  "grep",
  "read",
  "find",
  "read",
  "grep",
  "read",
  "bash",
  "edit",
] as const;
const BLOCKS = 20;

export const TOOL_STORM = {
  blocks: BLOCKS,
  perBlock: [...BLOCK],
  /** Exploration calls (read / grep / find) opening each block, grouped into one row. */
  explorationPerGroup: 8,
  /** The finished group's label after "Explored". */
  groupLabel: "5 files, 3 searches",
  text: "Done: all 20 modules are updated and the checks pass.",
};

function toolCall(
  r: Recorder,
  name: string,
  block: number,
  index: number,
): {
  call: Extract<Part, { kind: "toolCall" }>;
  result: Rec;
} {
  const id = r.toolId();
  const file = `src/module-${block}/file-${index}.ts`;
  const text = (t: string) => ({ content: [{ type: "text", text: t }] });
  switch (name) {
    case "read":
      return {
        call: { kind: "toolCall", id, name, args: { path: file } },
        result: text(
          `export const value${index} = ${block * 10 + index};\nexport function get() {\n  return value${index};\n}\n`,
        ),
      };
    case "grep":
      return {
        call: {
          kind: "toolCall",
          id,
          name,
          args: { pattern: `value${index}`, path: `src/module-${block}` },
        },
        result: text(
          `${file}:1: export const value${index} = ${block * 10 + index};\n${file}:3:   return value${index};`,
        ),
      };
    case "find":
      return {
        call: {
          kind: "toolCall",
          id,
          name,
          args: { pattern: "*.ts", path: `src/module-${block}` },
        },
        result: text(
          `src/module-${block}/file-0.ts\nsrc/module-${block}/file-1.ts\nsrc/module-${block}/file-3.ts`,
        ),
      };
    case "bash":
      return {
        call: { kind: "toolCall", id, name, args: { command: `pnpm test src/module-${block}` } },
        result: text("ok"),
      };
    default: {
      const old = `value${index} = ${block * 10 + index}`;
      const updated = `value${index} = ${block * 10 + index + 1}`;
      return {
        call: {
          kind: "toolCall",
          id,
          name,
          args: { path: file, edits: [{ oldText: old, newText: updated }] },
        },
        result: {
          ...text(`Successfully replaced 1 block(s) in ${file}.`),
          details: {
            diff: `-1 export const ${old};\n+1 export const ${updated};\n 2 export function get() {`,
            patch: `--- ${file}\n+++ ${file}\n@@ -1,2 +1,2 @@\n-export const ${old};\n+export const ${updated};\n export function get() {\n`,
            firstChangedLine: 1,
          },
        },
      };
    }
  }
}

function toolStorm(r: Recorder): void {
  for (let block = 0; block < BLOCKS; block++) {
    BLOCK.forEach((name, index) => {
      const { call, result } = toolCall(r, name, block, index);
      r.advance(10);
      const message = r.assistant([call], "toolUse", () => 0);
      const toolResult = r.tool(call, result);
      r.turnEnd(message, [toolResult], true);
    });
  }
  const message = r.assistant(
    [{ kind: "text", deltas: tokenize(TOOL_STORM.text, 5) }],
    "stop",
    () => DELTA_MS,
  );
  r.turnEnd(message, [], false);
}

// ---------------------------------------------------------------------------
// history

export const HISTORY = {
  text: "Here is the function you asked about, unchanged since @src/app.ts:3:\n\n```ts\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n```\n\nIt has no side effects.",
};

function history(r: Recorder, opts: FixtureOptions): void {
  r.entry({ type: "model_change", provider: "anthropic", modelId: "claude-haiku-4-5" });
  r.entry({ type: "thinking_level_change", thinkingLevel: "low" });
  r.entry({ type: "message", message: systemMessage(opts.cwd, r.now()) });
  r.entry({ type: "message", message: userMessage(opts.prompt, r.now()) });
  r.advance(2000);
  const timestamp = r.now();
  r.entry({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: HISTORY.text }],
      ...MODEL,
      usage: USAGE,
      stopReason: "stop",
      timestamp,
      responseId: `msg_e2e_${timestamp}`,
      responseModel: "claude-haiku-4-5-20251001",
      rawStopReason: "end_turn",
    },
  });
}

// ---------------------------------------------------------------------------

export function generateFixture(kind: FixtureKind, opts: FixtureOptions): FixtureLine[] {
  const r = new Recorder();
  if (kind === "history") {
    history(r, opts);
  } else {
    r.startRun(opts);
    r.advance(800);
    if (kind === "short-answer") shortAnswer(r);
    else if (kind === "long-stream") longStream(r);
    else toolStorm(r);
    r.endRun();
  }
  r.trailer(opts);
  return r.lines;
}

export function writeFixture(file: string, kind: FixtureKind, opts: FixtureOptions): void {
  const lines = generateFixture(kind, opts);
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}
