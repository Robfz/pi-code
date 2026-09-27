/**
 * Test helpers: a tiny scripted stand-in for `pi --mode rpc`, and fake-pi wiring.
 *
 * The stub reads LF-terminated JSON commands and, per command:
 * - `echo_size`: answers with the received line's length (backpressure tests);
 * - writes `chunks` (base64 byte strings) to stdout one by one, 5 ms apart;
 * - writes `stderr` lines;
 * - exits with `exit`, if set.
 * It exits when stdin ends, unless `STUB_IGNORE_EOF` is set; `STUB_IGNORE_TERM` ignores SIGTERM.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { FAKE_PI_PATH, fixturePath } from "../../../../test/fake-pi.ts";

const STUB_SOURCE = String.raw`
const write = (stream, data) => new Promise((r) => stream.write(data, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let buf = "";
let chain = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const cmd = JSON.parse(line);
    chain = chain.then(() => run(cmd, line.length));
  }
});
process.stdin.on("end", () => {
  if (!process.env.STUB_IGNORE_EOF) chain.then(() => process.exit(0));
});
if (process.env.STUB_IGNORE_TERM) process.on("SIGTERM", () => {});
if (process.env.STUB_IGNORE_EOF) setInterval(() => {}, 1000);
async function run(cmd, size) {
  if (cmd.type === "echo_size") {
    await write(process.stdout, JSON.stringify({ id: cmd.id, type: "response", command: "echo_size", success: true, data: size }) + "\n");
  }
  for (const c of cmd.chunks ?? []) {
    await write(process.stdout, Buffer.from(c, "base64"));
    await sleep(5);
  }
  for (const l of cmd.stderr ?? []) await write(process.stderr, l + "\n");
  if (cmd.exit !== undefined) process.exit(cmd.exit);
}
`;

export const STUB_BIN = process.execPath;
export const STUB_ARGS = ["-e", STUB_SOURCE];

export function spawnStub(env: Record<string, string> = {}): ChildProcessWithoutNullStreams {
  return spawn(STUB_BIN, STUB_ARGS, {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Base64 of the UTF-8 bytes of `text`, split at the given byte offsets. */
export function chunksOf(text: string | Uint8Array, splitAt: number[] = []): string[] {
  const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : Buffer.from(text);
  const out: string[] = [];
  let start = 0;
  for (const at of [...splitAt, bytes.length]) {
    out.push(bytes.subarray(start, at).toString("base64"));
    start = at;
  }
  return out;
}

/** `bin` + `args` running the fake pi on a fixture (name or path). */
export function fakePiCommand(fixture: string): { bin: string; args: string[] } {
  return { bin: process.execPath, args: [FAKE_PI_PATH, fixturePath(fixture), "--speed=0"] };
}

/** Whether a process with this pid is still alive. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
