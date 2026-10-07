/**
 * Records real `pi --mode rpc` sessions to `test/fixtures/<name>.jsonl`.
 *
 * Usage (from the repo root):
 *   packages/server/node_modules/.bin/tsx scripts/record-fixture.ts <scenario...|all>
 *   packages/server/node_modules/.bin/tsx scripts/record-fixture.ts --list
 *
 * Each fixture line is `{"t":ms,"dir":"in"|"out"|"err","line":<parsed JSON or raw string>}`:
 * `in` = a command written to pi's stdin, `out` = a stdout record, `err` = a stderr line.
 * `t` is milliseconds since spawn.
 *
 * Every scenario runs in a fresh scratch git repo under /tmp/pi-code-s0/work/<name>, with
 * sessions persisted to /tmp/pi-code-s0/sessions/<name> (never ~/.pi). User-installed
 * extensions and packages load as they would for a real client.
 *
 * Like the pi-code server, the recorder syncs entries after every `message_end` and
 * `entry_appended` with `get_entries {since: <last seen id>}` (one request in flight at a time).
 * Every scenario ends with `get_state`, `get_entries` and `get_session_stats`.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Json = Record<string, unknown>;
type Rec = Json & { type?: string; id?: string };
type Pred = (rec: Rec) => boolean;

interface Ctx {
  outs: Rec[];
  lastResponse(command: string): Rec | undefined;
  entries: Rec[];
  scratch: string;
}

type Step =
  | { send: Json | ((ctx: Ctx) => Json); wait?: "response" | string | Pred; timeoutMs?: number }
  | { wait: string | Pred; timeoutMs?: number; optional?: boolean }
  | { sleep: number };

interface Scenario {
  description: string;
  extraArgs?: string[];
  /** Answers dialog `extension_ui_request`s; return undefined to leave one unanswered. */
  answerUi?: (req: Rec) => Json | undefined;
  setup?: (scratch: string) => void;
  steps: Step[];
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "/tmp/pi-code-s0";
const EXT_PATH = join(BASE, "ext", "s0-ext.ts");
const MODEL = "anthropic/claude-haiku-4-5";
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

const settled: Step = { wait: "agent_settled", timeoutMs: 180_000 };
const prompt = (message: string, extra: Json = {}): Step => ({
  send: { type: "prompt", message, ...extra },
});
const isEvent =
  (type: string, sub?: string): Pred =>
  (r) =>
    r.type === type &&
    (sub === undefined || (r.assistantMessageEvent as Json | undefined)?.type === sub);

/** Throwaway extension exercising extension UI and session-entry APIs. */
const S0_EXTENSION = `
export default function (pi: any) {
  pi.registerCommand("s0-dialog", {
    description: "S0 spike: exercise every extension UI method",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify("s0 notify info", "info");
      ctx.ui.notify("s0 notify warning", "warning");
      ctx.ui.setStatus("s0", "s0 status text");
      ctx.ui.setWidget("s0", ["s0 widget line 1", "s0 widget line 2"]);
      ctx.ui.setWidget("s0-below", ["s0 below"], { placement: "belowEditor" });
      ctx.ui.setTitle("s0 title");
      ctx.ui.setEditorText("s0 editor text");
      const choice = await ctx.ui.select("S0 pick a fruit", ["apple", "banana", "cherry"]);
      const ok = await ctx.ui.confirm("S0 confirm?", "You picked " + choice);
      const text = await ctx.ui.input("S0 input", "type here");
      const edited = await ctx.ui.editor("S0 editor", "line1\\nline2");
      const timed = await ctx.ui.select("S0 timeout select", ["x", "y"], { timeout: 1500 });
      ctx.ui.notify("s0 result " + JSON.stringify({ choice, ok, text, edited, timed }), "info");
      ctx.ui.setStatus("s0", undefined);
      ctx.ui.setWidget("s0", undefined);
      ctx.ui.setWidget("s0-below", undefined);
    },
  });

  pi.registerCommand("s0-entries", {
    description: "S0 spike: append custom entry, custom message, label",
    handler: async (_args: string, ctx: any) => {
      pi.appendEntry("s0-state", { n: 1 });
      pi.sendMessage({ customType: "s0-msg", content: "s0 injected context", display: true, details: { k: "v" } });
      const entries = ctx.sessionManager.getEntries();
      const firstUser = entries.find((e: any) => e.type === "message" && e.message.role === "user");
      if (firstUser) pi.setLabel(firstUser.id, "s0-label-via-ext");
    },
  });

  pi.registerCommand("s0-branch", {
    description: "S0 spike: navigate to the first assistant message with a branch summary",
    handler: async (_args: string, ctx: any) => {
      const entries = ctx.sessionManager.getEntries();
      const target = entries.find((e: any) => e.type === "message" && e.message.role === "assistant");
      if (!target) { ctx.ui.notify("no assistant entry", "error"); return; }
      const res = await ctx.navigateTree(target.id, { summarize: true });
      ctx.ui.notify("s0 navigateTree " + JSON.stringify(res), "info");
    },
  });
}
`;

const FILES: Record<string, string> = {
  "README.md": "# scratch\n\nA tiny scratch project for pi-code fixture recording.\n",
  "notes.txt": "I like apple pie.\nApples are red.\n",
  "a.txt": "alpha: the first file\n",
  "b.txt": "beta: the second file\n",
};

const scenarios: Record<string, Scenario> = {
  "plain-answer": {
    description: "short question, thinking low",
    steps: [prompt("In one short sentence: what is a monad?"), settled],
  },
  "tool-calls": {
    description: "read + edit tool calls",
    steps: [
      prompt(
        "Read notes.txt, then use the edit tool to replace 'apple pie' with 'banana bread'. Reply with one short line when done.",
      ),
      settled,
    ],
  },
  "parallel-tools": {
    description: "two read calls in one assistant message",
    steps: [
      prompt(
        "Read a.txt and b.txt in parallel: issue both read tool calls in the same response. Then say in one line what each contains.",
      ),
      settled,
    ],
  },
  "steer-followup": {
    description: "multi-turn task, steer mid-run, follow_up queued",
    steps: [
      prompt(
        "Run the bash command `sleep 2 && echo tick` three separate times, one tool call per response (never in parallel). Then reply 'done'.",
      ),
      { wait: "tool_execution_start", timeoutMs: 60_000 },
      { send: { type: "steer", message: "Also read a.txt after the sleeps." }, wait: "response" },
      {
        send: {
          type: "follow_up",
          message: "When everything is finished, reply with just FOLLOWUP-OK.",
        },
        wait: "response",
      },
      {
        send: {
          type: "prompt",
          message: "(steer sent via prompt) keep answers short.",
          streamingBehavior: "steer",
        },
        wait: "response",
      },
      settled,
    ],
  },
  abort: {
    description: "abort mid text stream, then abort during a running bash tool",
    steps: [
      prompt("Write a 400-word story about a lighthouse keeper."),
      { wait: isEvent("message_update", "text_delta"), timeoutMs: 60_000 },
      { sleep: 800 },
      { send: { type: "abort" }, wait: "response" }, // responds after agent_settled
      { sleep: 500 },
      prompt("Run the bash command `sleep 30 && echo finished` and report the output."),
      { wait: "tool_execution_start", timeoutMs: 60_000 },
      { sleep: 1500 },
      { send: { type: "abort" }, wait: "response" }, // responds after agent_settled
      { sleep: 500 },
    ],
  },
  compaction: {
    description:
      "compact on a tiny session (fails), bulk bash output to pass keepRecentTokens, two turns, compact, one more turn",
    steps: [
      prompt("Remember the codeword PINEAPPLE. Reply only OK."),
      settled,
      { send: { type: "compact" }, wait: "response", timeoutMs: 60_000 },
      // ~60k tokens of context so there is something before the keepRecentTokens (20k) cut;
      // each output is truncated at 2000 lines.
      ...[1, 2, 3].map(
        (n): Step => ({
          send: { type: "bash", command: `seq 1 2100 | sed 's/$/ filler line ${n} lorem ipsum/'` },
          wait: "response",
        }),
      ),
      prompt("What is 2+2? Reply with one word."),
      settled,
      { send: { type: "compact" }, wait: "response", timeoutMs: 180_000 },
      prompt("What was the codeword? One word."),
      settled,
    ],
  },
  "bash-command": {
    description: "RPC bash command (+excludeFromContext), then a prompt",
    steps: [
      {
        send: { type: "bash", command: "echo one; sleep 0.3; echo two; sleep 0.3; ls" },
        wait: "response",
      },
      {
        send: { type: "bash", command: "echo hidden-output", excludeFromContext: true },
        wait: "response",
      },
      { send: { type: "bash", command: "exit 3" }, wait: "response" },
      prompt("What files did the ls output show? One line."),
      settled,
    ],
  },
  "extension-dialog": {
    description: "throwaway extension: select/confirm/input/editor/timeout + fire-and-forget UI",
    extraArgs: ["--extension", EXT_PATH],
    answerUi: (req) => {
      const title = String(req.title ?? "");
      if (title.includes("timeout")) return undefined; // let pi's timeout fire
      if (req.method === "select") return { value: (req.options as string[])[1] };
      if (req.method === "confirm") return { confirmed: true };
      if (req.method === "input") return { value: "hello from s0" };
      return { cancelled: true }; // editor
    },
    steps: [
      { send: { type: "prompt", message: "/s0-dialog" }, wait: "response", timeoutMs: 30_000 },
      { sleep: 500 },
    ],
  },
  "slash-commands": {
    description: "built-in slash commands sent via prompt (/name, /compact, /model)",
    steps: [
      prompt("/name foo"),
      { wait: "agent_settled", timeoutMs: 60_000, optional: true },
      { send: { type: "get_state" }, wait: "response" },
      prompt("/compact"),
      { wait: "agent_settled", timeoutMs: 60_000, optional: true },
      { send: { type: "get_state" }, wait: "response" },
    ],
  },
  "entry-types": {
    description:
      "session_info, model_change, thinking_level_change, label, custom, custom_message, branch_summary, fork, new_session",
    extraArgs: ["--extension", EXT_PATH],
    steps: [
      prompt("Say hi in three words."),
      settled,
      { send: { type: "set_session_name", name: "s0 entries" }, wait: "response" },
      {
        send: { type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4-5" },
        wait: "response",
      },
      {
        send: { type: "set_model", provider: "anthropic", modelId: "claude-haiku-4-5" },
        wait: "response",
      },
      { send: { type: "set_thinking_level", level: "minimal" }, wait: "response" },
      { send: { type: "prompt", message: "/label s0-label" }, wait: "response" },
      { send: { type: "prompt", message: "/s0-entries" }, wait: "response" },
      { sleep: 500 },
      prompt("Say bye in two words."),
      settled,
      { send: { type: "prompt", message: "/s0-branch" }, wait: "response", timeoutMs: 120_000 },
      { sleep: 500 },
      prompt("Say ok."),
      settled,
      { send: { type: "get_tree" }, wait: "response" },
      { send: { type: "get_entries" }, wait: "response" },
      { send: { type: "get_fork_messages" }, wait: "response" },
      {
        send: (ctx) => {
          const data = ctx.lastResponse("get_fork_messages")?.data as
            | { messages: Json[] }
            | undefined;
          const msgs = data?.messages ?? [];
          return { type: "fork", entryId: msgs.at(-1)?.entryId };
        },
        wait: "response",
      },
      { send: { type: "get_state" }, wait: "response" },
      { send: { type: "get_entries" }, wait: "response" },
      { send: { type: "clone" }, wait: "response" },
      { send: { type: "get_state" }, wait: "response" },
      { send: { type: "new_session" }, wait: "response" },
    ],
  },
  subagent: {
    description: "user subagent extension (auto-loaded) running a project-local haiku agent",
    setup: (scratch) => {
      mkdirSync(join(scratch, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(scratch, ".pi", "agents", "tiny.md"),
        "---\nname: tiny\ndescription: Tiny cheap test agent\ntools: read\nmodel: claude-haiku-4-5\n---\nYou are terse. Answer in one line.\n",
      );
    },
    answerUi: (req) => (req.method === "confirm" ? { confirmed: true } : { cancelled: true }),
    steps: [
      prompt(
        'Call the spawn tool once with agent "tiny", agentScope "project", and task "Read a.txt and reply with its contents". Then relay its answer in one line.',
      ),
      settled,
    ],
  },
  "web-search": {
    description: "pi-web-access web_search (curator workflow off)",
    steps: [
      prompt(
        'Use the web_search tool once (query: "Node.js current LTS codename", workflow "none") and answer in one line.',
      ),
      settled,
    ],
  },
};

function prepareScratch(name: string, scenario: Scenario): { cwd: string; sessionDir: string } {
  const cwd = join(BASE, "work", name);
  const sessionDir = join(BASE, "sessions", name);
  rmSync(cwd, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  for (const [file, content] of Object.entries(FILES)) writeFileSync(join(cwd, file), content);
  scenario.setup?.(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=s0", "-c", "user.email=s0@example.invalid", "commit", "-qm", "init");
  mkdirSync(dirname(EXT_PATH), { recursive: true });
  writeFileSync(EXT_PATH, S0_EXTENSION);
  return { cwd, sessionDir };
}

/** LF-only line splitter over a UTF-8 stream (never readline: U+2028 is valid inside JSON). */
function lineSplitter(onLine: (line: string) => void) {
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  return {
    push(chunk: Buffer) {
      buf += decoder.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        onLine(line);
        nl = buf.indexOf("\n");
      }
    },
    end() {
      buf += decoder.decode();
      if (buf.length > 0) onLine(buf.endsWith("\r") ? buf.slice(0, -1) : buf);
      buf = "";
    },
  };
}

async function record(name: string, scenario: Scenario): Promise<boolean> {
  const { cwd, sessionDir } = prepareScratch(name, scenario);
  const args = [
    "--mode",
    "rpc",
    "--model",
    MODEL,
    "--thinking",
    "low",
    "--session-dir",
    sessionDir,
    ...(scenario.extraArgs ?? []),
  ];
  const env = { ...process.env };
  delete env.HERDR_ENV;
  const start = Date.now();
  const lines: string[] = [];
  const log = (dir: "in" | "out" | "err", line: unknown) =>
    lines.push(JSON.stringify({ t: Date.now() - start, dir, line }));

  console.error(`\n[${name}] pi ${args.join(" ")}  (cwd ${cwd})`);
  const child: ChildProcess = spawn("pi", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const outs: Rec[] = [];
  const responses = new Map<string, Rec>();
  const waiters = new Set<() => void>();
  let exited = false;
  child.on("exit", () => {
    exited = true;
    for (const w of waiters) w();
  });

  let nextId = 1;
  const send = (cmd: Json): string => {
    const id = (cmd.id as string | undefined) ?? `${name}-${nextId++}`;
    const full = cmd.type === "extension_ui_response" ? cmd : { id, ...cmd };
    log("in", full);
    child.stdin?.write(`${JSON.stringify(full)}\n`);
    return id;
  };

  // Entry sync, like the pi-code server: one get_entries {since} in flight at a time.
  let lastEntryId: string | undefined;
  let syncInFlight: string | undefined;
  let syncDirty = false;
  const entries: Rec[] = [];
  const requestSync = () => {
    if (syncInFlight) {
      syncDirty = true;
      return;
    }
    syncDirty = false;
    syncInFlight = send(
      lastEntryId ? { type: "get_entries", since: lastEntryId } : { type: "get_entries" },
    );
  };

  const onOut = (rec: Rec) => {
    outs.push(rec);
    if (rec.type === "response" && typeof rec.id === "string") {
      responses.set(rec.id, rec);
      if (rec.command === "get_entries" && rec.success) {
        const got = ((rec.data as Json).entries as Rec[]) ?? [];
        if (rec.id === syncInFlight || !lastEntryId) entries.push(...got);
        const last = got.at(-1);
        if (last && typeof last.id === "string") lastEntryId = last.id;
      }
      if (
        ["new_session", "fork", "clone", "switch_session"].includes(String(rec.command)) &&
        rec.success
      ) {
        lastEntryId = undefined;
      }
      if (rec.id === syncInFlight) {
        syncInFlight = undefined;
        if (syncDirty) requestSync();
      }
    }
    if (rec.type === "message_end" || rec.type === "entry_appended") requestSync();
    if (rec.type === "extension_ui_request" && DIALOG_METHODS.has(String(rec.method))) {
      const answer = scenario.answerUi?.(rec);
      if (answer) {
        setTimeout(() => send({ type: "extension_ui_response", id: rec.id, ...answer }), 300);
      }
    }
    for (const w of waiters) w();
  };

  const stdout = lineSplitter((line) => {
    if (line.length === 0) return;
    let parsed: unknown = line;
    try {
      parsed = JSON.parse(line);
    } catch {}
    log("out", parsed);
    if (parsed && typeof parsed === "object") onOut(parsed as Rec);
  });
  const stderr = lineSplitter((line) => {
    if (line.length > 0) log("err", line);
  });
  child.stdout?.on("data", (c: Buffer) => stdout.push(c));
  child.stdout?.on("end", () => stdout.end());
  child.stderr?.on("data", (c: Buffer) => stderr.push(c));
  child.stderr?.on("end", () => stderr.end());

  let cursor = 0;
  const waitFor = (pred: Pred, timeoutMs: number): Promise<boolean> =>
    new Promise((res) => {
      const check = () => {
        for (let i = cursor; i < outs.length; i++) {
          if (pred(outs[i] as Rec)) {
            cursor = i + 1;
            done(true);
            return;
          }
        }
        if (exited) done(false);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        waiters.delete(check);
        res(ok);
      };
      waiters.add(check);
      check();
    });

  const ctx: Ctx = {
    outs,
    entries,
    scratch: cwd,
    lastResponse: (command) => [...responses.values()].filter((r) => r.command === command).at(-1),
  };
  const toPred = (w: string | Pred, id?: string): Pred =>
    typeof w === "function"
      ? w
      : w === "response"
        ? (r) => r.type === "response" && r.id === id
        : (r) => r.type === w;

  const finalSteps: Step[] = [
    { sleep: 1000 },
    { send: { type: "get_state" }, wait: "response" },
    { send: { type: "get_entries" }, wait: "response" },
    { send: { type: "get_session_stats" }, wait: "response" },
  ];

  let ok = true;
  for (const step of [...scenario.steps, ...finalSteps]) {
    if ("sleep" in step) {
      await new Promise((r) => setTimeout(r, step.sleep));
    } else if ("send" in step) {
      const cmd = typeof step.send === "function" ? step.send(ctx) : step.send;
      cursor = outs.length;
      const id = send(cmd);
      if (step.wait && !(await waitFor(toPred(step.wait, id), step.timeoutMs ?? 60_000))) {
        console.error(`[${name}] timeout waiting after ${JSON.stringify(cmd)}`);
        ok = false;
        break;
      }
    } else {
      const got = await waitFor(toPred(step.wait), step.timeoutMs ?? 60_000);
      if (!got && !step.optional) {
        console.error(`[${name}] timeout waiting for ${String(step.wait)}`);
        ok = false;
        break;
      }
      if (!got) console.error(`[${name}] (optional wait for ${String(step.wait)} timed out)`);
    }
  }

  child.stdin?.end();
  await new Promise<void>((res) => {
    if (exited) return res();
    const t = setTimeout(() => {
      child.kill("SIGTERM");
      res();
    }, 10_000);
    child.on("exit", () => {
      clearTimeout(t);
      res();
    });
  });
  await new Promise((r) => setTimeout(r, 100));

  const file = join(ROOT, "test", "fixtures", `${name}.jsonl`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  console.error(`[${name}] ${ok ? "ok" : "FAILED"} — ${lines.length} lines → ${file}`);
  return ok;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--list")) {
    for (const [name, s] of Object.entries(scenarios))
      console.log(`${name.padEnd(18)} ${s.description}`);
    return;
  }
  const names = argv.includes("all") ? Object.keys(scenarios) : argv;
  let failed = 0;
  for (const name of names) {
    const scenario = scenarios[name];
    if (!scenario) {
      console.error(`unknown scenario: ${name}`);
      failed++;
      continue;
    }
    if (!(await record(name, scenario))) failed++;
  }
  process.exitCode = failed ? 1 : 0;
}

await main();
