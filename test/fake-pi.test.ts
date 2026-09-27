import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { createLineSplitter, spawnFakePi } from "./fake-pi.ts";

// biome-ignore lint/suspicious/noExplicitAny: loosely typed RPC records in assertions
type Rec = Record<string, any>;

/** Minimal RPC client: LF-split stdout, send commands, wait for records. */
class TinyClient {
  readonly records: Rec[] = [];
  readonly stderr: string[] = [];
  private cursor = 0;
  private waiters = new Set<() => void>();
  private exited = false;

  constructor(readonly proc: ChildProcessWithoutNullStreams) {
    const out = createLineSplitter((line) => {
      if (line.length === 0) return;
      this.records.push(JSON.parse(line));
      for (const w of this.waiters) w();
    });
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    const err = createLineSplitter((line) => this.stderr.push(line));
    proc.stderr.on("data", (c: Buffer) => err.push(c));
    proc.on("close", () => {
      this.exited = true;
      for (const w of this.waiters) w();
    });
  }

  send(cmd: Rec) {
    this.proc.stdin.write(`${JSON.stringify(cmd)}\n`);
  }

  /** Waits for the next record (after the previous match) satisfying `pred`. */
  next(pred: (r: Rec) => boolean, timeoutMs = 5000): Promise<Rec> {
    return new Promise((resolve, reject) => {
      const check = () => {
        for (let i = this.cursor; i < this.records.length; i++) {
          if (pred(this.records[i] as Rec)) {
            this.cursor = i + 1;
            done();
            resolve(this.records[i] as Rec);
            return;
          }
        }
        if (this.exited) {
          done();
          reject(new Error("fake pi exited"));
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`timeout; stderr: ${this.stderr.join("\n")}`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      this.waiters.add(check);
      check();
    });
  }

  async request(cmd: Rec): Promise<Rec> {
    this.send(cmd);
    return this.next((r) => r.type === "response" && r.id === cmd.id);
  }

  close(): Promise<number | null> {
    return new Promise((resolve) => {
      if (this.exited) return resolve(this.proc.exitCode);
      this.proc.on("close", (code) => resolve(code));
      this.proc.stdin.end();
    });
  }
}

const clients: TinyClient[] = [];
const start = (fixture: string, speed = 0) => {
  const c = new TinyClient(spawnFakePi(fixture, { speed }));
  clients.push(c);
  return c;
};

afterEach(() => {
  for (const c of clients.splice(0)) c.proc.kill();
});

describe("fake pi", () => {
  test("replays plain-answer with rewritten ids and answers queries", async () => {
    const c = start("plain-answer");

    // Queries before anything happened: nothing recorded yet.
    const early = await c.request({ id: "q0", type: "get_entries" });
    expect(early.data).toEqual({ entries: [], leafId: null });

    const prompt = await c.request({ id: "my-prompt", type: "prompt", message: "anything" });
    expect(prompt).toMatchObject({ command: "prompt", success: true });

    const end = await c.next((r) => r.type === "message_end" && r.message.role === "assistant");
    await c.next((r) => r.type === "agent_settled");

    // Streamed text deltas reconstruct the final text.
    const streamed = c.records
      .filter((r) => r.type === "message_update" && r.assistantMessageEvent.type === "text_delta")
      .map((r) => r.assistantMessageEvent.delta)
      .join("");
    const finalText = end.message.content.find((b: Rec) => b.type === "text").text;
    expect(streamed).toBe(finalText);

    // Recorded query responses are not replayed on their own.
    expect(c.records.filter((r) => r.type === "response").map((r) => r.id)).toEqual([
      "q0",
      "my-prompt",
    ]);

    // get_entries from the rebuilt entry list, with a since cursor.
    const all = await c.request({ id: "e1", type: "get_entries" });
    const types = all.data.entries.map((e: Rec) =>
      e.type === "message" ? e.message.role : e.type,
    );
    expect(types).toEqual(["model_change", "thinking_level_change", "system", "user", "assistant"]);
    const userId = all.data.entries[3].id;
    const since = await c.request({ id: "e2", type: "get_entries", since: userId });
    expect(since.data.entries.map((e: Rec) => e.message.role)).toEqual(["assistant"]);
    expect(since.data.leafId).toBe(all.data.entries[4].id);
    const bad = await c.request({ id: "e3", type: "get_entries", since: "nope" });
    expect(bad).toMatchObject({ success: false, error: "Entry not found: nope" });

    const state = await c.request({ id: "s1", type: "get_state" });
    expect(state.data).toMatchObject({ isStreaming: false, thinkingLevel: "low" });
    const stats = await c.request({ id: "s2", type: "get_session_stats" });
    expect(stats.data.assistantMessages).toBe(1);

    // A gating command that isn't in the fixture is rejected.
    const unexpected = await c.request({ id: "x1", type: "abort" });
    expect(unexpected).toMatchObject({ success: false });

    expect(c.stderr).toContain(
      "[pi-web-access] Dynamic tool activation requires Pi 0.86.1 or newer; web tools remain eagerly available.",
    );
    expect(await c.close()).toBe(0);
  });

  test("replays extension-dialog, waiting for each extension_ui_response", async () => {
    const c = start("extension-dialog");
    c.send({ id: "cmd", type: "prompt", message: "/s0-dialog" });

    const select = await c.next((r) => r.type === "extension_ui_request" && r.method === "select");
    expect(select).toMatchObject({
      title: "S0 pick a fruit",
      options: ["apple", "banana", "cherry"],
    });
    // Nothing past the dialog is replayed until it is answered.
    await new Promise((r) => setTimeout(r, 100));
    expect(c.records.at(-1)).toBe(select);

    c.send({ type: "extension_ui_response", id: select.id, value: "banana" });
    const confirm = await c.next(
      (r) => r.type === "extension_ui_request" && r.method === "confirm",
    );
    expect(confirm.message).toBe("You picked banana");
    c.send({ type: "extension_ui_response", id: confirm.id, confirmed: true });
    const input = await c.next((r) => r.type === "extension_ui_request" && r.method === "input");
    c.send({ type: "extension_ui_response", id: input.id, value: "hello from s0" });
    const editor = await c.next((r) => r.type === "extension_ui_request" && r.method === "editor");
    expect(editor.prefill).toBe("line1\nline2");
    c.send({ type: "extension_ui_response", id: editor.id, cancelled: true });

    // The timed-out select is never answered; the command response follows.
    const timed = await c.next((r) => r.method === "select");
    expect(timed.timeout).toBe(1500);
    const resp = await c.next((r) => r.type === "response");
    expect(resp).toMatchObject({ id: "cmd", command: "prompt", success: true });

    const methods = c.records.filter((r) => r.type === "extension_ui_request").map((r) => r.method);
    expect(methods).toEqual(
      expect.arrayContaining(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]),
    );
    expect(await c.close()).toBe(0);
  });

  test("speed=1 keeps the recorded spacing", async () => {
    const c = start("extension-dialog", 1);
    const t0 = Date.now();
    c.send({ id: "cmd", type: "prompt", message: "/s0-dialog" });
    await c.next((r) => r.method === "select" && r.title === "S0 pick a fruit");
    // Recorded ~435 ms between the prompt and the dialog.
    expect(Date.now() - t0).toBeGreaterThan(300);
  });
});
