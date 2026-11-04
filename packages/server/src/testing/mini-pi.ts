/**
 * A tiny scripted stand-in for `pi --mode rpc` with real session files, for lifecycle tests
 * (resume, restart, fork, tree navigation). Runs directly with Node's type stripping.
 *
 *   node mini-pi.ts [--session <file>]
 *
 * - Startup: writes `mini-pi argv=<json> trust=<PI_CODE_TRUST or ->` to stderr; every session
 *   start (startup included) sends a `setStatus` keyed `mini:<session id>`.
 * - Sessions live in `MINI_PI_SESSION_DIR` (new ones) and are saved on every change (header +
 *   entries), so a restarted process resumes them with `--session`.
 * - `prompt "<text>"`: answers on acceptance, then emits a minimal run (user + assistant
 *   entries, `turn_end`, `agent_end`, `agent_settled`). `prompt "crash"` exits with code 3 after
 *   `fatal: crashed` on stderr; `prompt "hang"` starts a run that never ends (with a running
 *   `bash` tool `hang-tool` and a queued steering message). During that run, like pi, a prompt
 *   needs `streamingBehavior` and is only queued.
 * - `prompt "/pi-code-tree {json}"` (unless `MINI_PI_NO_EXT`): moves the leaf like pi's
 *   `navigateTree` (to the parent of a user message, whose text goes to `set_editor_text`), with a
 *   `branch_summary` when `summarize` (announced with `entry_appended` when
 *   `MINI_PI_TREE_ENTRY_EVENT` is set); with `MINI_PI_TREE_FAIL` it emits `extension_error`
 *   instead; answers after.
 * - `fork`, `clone`, `new_session`, `switch_session`, `get_*` queries.
 * - End of stdin: exits, saving the session first when `MINI_PI_SAVE_ON_EXIT` is set.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Entry = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
};

const argv = process.argv.slice(2);
const sessionArg = argv.includes("--session") ? argv[argv.indexOf("--session") + 1] : undefined;
const sessionDir = process.env.MINI_PI_SESSION_DIR ?? process.cwd();
process.stderr.write(
  `mini-pi argv=${JSON.stringify(argv)} trust=${process.env.PI_CODE_TRUST ?? "-"}\n`,
);

let sessionFile = "";
let sessionId = "";
let parentSession: string | undefined;
let entries: Entry[] = [];
let leafId: string | null = null;
let nextId = 0;
let ts = Date.parse("2026-01-01T00:00:00.000Z");
/** The steering queue of the run `prompt "hang"` started, which never ends. */
let steering: string[] | undefined;

const out = (record: unknown) => process.stdout.write(`${JSON.stringify(record)}\n`);
const stamp = () => {
  ts += 1000;
  return new Date(ts).toISOString();
};
const newId = () => `m${(++nextId).toString(16).padStart(7, "0")}`;

function save(): void {
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date(ts).toISOString(),
    cwd: process.cwd(),
    ...(parentSession ? { parentSession } : {}),
  };
  writeFileSync(sessionFile, `${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
}

function startSession(file: string | undefined, parent?: string): void {
  if (file !== undefined && existsSync(file)) {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const header = JSON.parse(lines[0] as string) as { id: string };
    sessionFile = file;
    sessionId = header.id;
    entries = lines.slice(1).map((l) => JSON.parse(l) as Entry);
    leafId = entries.at(-1)?.id ?? null;
    nextId = entries.length + 100;
  } else {
    sessionId = randomUUID();
    sessionFile = file ?? join(sessionDir, `${sessionId}.jsonl`);
    entries = [];
    leafId = null;
    parentSession = parent;
    save();
  }
  out({
    type: "extension_ui_request",
    id: randomUUID(),
    method: "setStatus",
    statusKey: `mini:${sessionId}`,
    statusText: "active",
  });
}

function append(entry: Omit<Entry, "id" | "parentId" | "timestamp">): Entry {
  const full = { ...entry, id: newId(), parentId: leafId, timestamp: stamp() } as Entry;
  entries.push(full);
  leafId = full.id;
  save();
  return full;
}

function byId(id: string): Entry | undefined {
  return entries.find((e) => e.id === id);
}

function pathTo(id: string | null): Entry[] {
  const path: Entry[] = [];
  let cur = id === null ? undefined : byId(id);
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId === null ? undefined : byId(cur.parentId);
  }
  return path;
}

function state() {
  return {
    model: { provider: "mini", id: "mini-1" },
    thinkingLevel: "off",
    isStreaming: steering !== undefined,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    sessionFile,
    sessionId,
    autoCompactionEnabled: false,
    messageCount: entries.filter((e) => e.type === "message").length,
    pendingMessageCount: 0,
  };
}

function textOf(entry: Entry): string {
  const message = entry.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: { text?: string }) => b.text ?? "").join("");
}

type Command = { id: string; type: string; [key: string]: unknown };

function ok(cmd: Command, data?: unknown) {
  out({ id: cmd.id, type: "response", command: cmd.type, success: true, data });
}
function fail(cmd: Command, error: string) {
  out({ id: cmd.id, type: "response", command: cmd.type, success: false, error });
}

function run(cmd: Command) {
  switch (cmd.type) {
    case "get_state":
      return ok(cmd, state());
    case "get_entries": {
      const since = cmd.since as string | undefined;
      if (since === undefined) return ok(cmd, { entries, leafId });
      const at = entries.findIndex((e) => e.id === since);
      if (at < 0) return fail(cmd, `Entry not found: ${since}`);
      return ok(cmd, { entries: entries.slice(at + 1), leafId });
    }
    case "get_session_stats":
      return ok(cmd, { sessionFile, sessionId, tokens: { total: 0 }, cost: 0 });
    case "get_commands":
      return ok(cmd, {
        commands: process.env.MINI_PI_NO_EXT
          ? [{ name: "other", source: "extension" }]
          : [{ name: "pi-code-tree", source: "extension" }],
      });
    case "prompt":
      return prompt(cmd, String(cmd.message));
    case "fork": {
      const target = byId(String(cmd.entryId));
      if (!target) return fail(cmd, "Entry not found");
      const kept = pathTo(target.parentId);
      const old = sessionFile;
      startSession(undefined, old);
      entries = kept;
      leafId = kept.at(-1)?.id ?? null;
      save();
      return ok(cmd, { text: textOf(target), cancelled: false });
    }
    case "clone": {
      const kept = pathTo(leafId);
      startSession(undefined, sessionFile);
      entries = kept;
      leafId = kept.at(-1)?.id ?? null;
      save();
      return ok(cmd, { cancelled: false });
    }
    case "new_session":
      startSession(undefined, sessionFile);
      return ok(cmd, { cancelled: false });
    case "switch_session":
      startSession(String(cmd.sessionPath));
      return ok(cmd, { cancelled: false });
    default:
      return fail(cmd, `mini-pi: unsupported command ${cmd.type}`);
  }
}

function prompt(cmd: Command, message: string) {
  if (message === "crash") {
    process.stderr.write("fatal: crashed\n", () => process.exit(3));
    return;
  }
  const tree = /^\/pi-code-tree (.*)$/s.exec(message);
  if (tree && !process.env.MINI_PI_NO_EXT) {
    const args = JSON.parse(tree[1] as string) as { entryId: string; summarize?: boolean };
    const target = byId(args.entryId);
    if (!target || process.env.MINI_PI_TREE_FAIL) {
      out({
        type: "extension_error",
        extensionPath: "command:pi-code-tree",
        event: "command",
        error: `Entry ${args.entryId} not found`,
      });
      return ok(cmd);
    }
    const fromId = leafId;
    const isUser =
      target.type === "message" && (target.message as { role?: string }).role === "user";
    leafId = isUser ? target.parentId : target.id;
    if (args.summarize && fromId !== null) {
      const summary = append({ type: "branch_summary", fromId, summary: "mini summary" });
      if (process.env.MINI_PI_TREE_ENTRY_EVENT) out({ type: "entry_appended", entry: summary });
    }
    if (isUser) {
      out({
        type: "extension_ui_request",
        id: randomUUID(),
        method: "set_editor_text",
        text: textOf(target),
      });
    }
    return ok(cmd);
  }
  if (steering !== undefined) {
    if (cmd.streamingBehavior === undefined) {
      return fail(
        cmd,
        "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
      );
    }
    steering.push(message);
    ok(cmd);
    out({ type: "queue_update", steering, followUp: [] });
    return;
  }
  if (message === "hang") {
    steering = ["queued"];
    ok(cmd);
    out({ type: "agent_start" });
    out({ type: "tool_execution_start", toolCallId: "hang-tool", toolName: "bash", args: {} });
    out({ type: "queue_update", steering, followUp: [] });
    return;
  }
  ok(cmd);
  const now = ts;
  const user = { role: "user", content: [{ type: "text", text: message }], timestamp: now };
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: `echo: ${message}` }],
    stopReason: "stop",
    timestamp: now + 1,
  };
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  out({ type: "message_start", message: user });
  append({ type: "message", message: user });
  out({ type: "message_end", message: user });
  out({ type: "message_start", message: assistant });
  append({ type: "message", message: assistant });
  out({ type: "message_end", message: assistant });
  out({ type: "turn_end", message: assistant, toolResults: [] });
  out({ type: "agent_end", messages: [user, assistant], willRetry: false });
  out({ type: "agent_settled" });
}

startSession(sessionArg);

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let nl = buf.indexOf("\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    nl = buf.indexOf("\n");
    if (line.trim()) run(JSON.parse(line) as Command);
  }
});
process.stdin.on("end", () => {
  if (process.env.MINI_PI_SAVE_ON_EXIT) save();
  process.exit(0);
});
