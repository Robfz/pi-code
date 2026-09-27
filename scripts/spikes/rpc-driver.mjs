// Generic RPC driver: node rpc-driver.mjs <cwd> <ext> <scenario>
// Logs every stdout JSONL line with relative timestamps. Splits on \n only.
import { spawn } from "node:child_process";

const [cwd, ext, scenario = "e1"] = process.argv.slice(2);
const extraArgs = (process.env.SPIKE_PI_ARGS ?? "").split(" ").filter(Boolean);
const args = ["--mode", "rpc", "--extension", ext, ...extraArgs];
const t0 = Date.now();
const ts = () => String(Date.now() - t0).padStart(6) + "ms";
const log = (s) => process.stdout.write(`${ts()} ${s}\n`);
log(`spawn pi ${args.join(" ")} cwd=${cwd}`);
const child = spawn("pi", args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const send = (obj) => {
  log(`>> ${JSON.stringify(obj)}`);
  child.stdin.write(JSON.stringify(obj) + "\n");
};
let buf = "";
const waiters = [];
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    let line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`<< (non-json) ${line}`);
      continue;
    }
    const short = line.length > 400 ? line.slice(0, 400) + "…" : line;
    log(`<< ${short}`);
    onMsg(msg);
    for (const w of [...waiters])
      if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.res(msg);
      }
  }
});
child.stderr.on("data", (d) => {
  for (const l of d.toString().split("\n")) if (l.trim()) log(`[stderr] ${l}`);
});
child.on("exit", (code, sig) => {
  log(`exit code=${code} sig=${sig}`);
  process.exit(0);
});
const waitFor = (pred, ms = 15000) =>
  new Promise((res, rej) => {
    const w = { pred, res };
    waiters.push(w);
    setTimeout(() => {
      const k = waiters.indexOf(w);
      if (k >= 0) {
        waiters.splice(k, 1);
        rej(new Error("timeout"));
      }
    }, ms);
  });
function onMsg(msg) {
  if (
    msg.type === "extension_ui_request" &&
    ["confirm", "select", "input", "editor"].includes(msg.method)
  ) {
    if (msg.method === "confirm")
      send({ type: "extension_ui_response", id: msg.id, confirmed: true });
    else send({ type: "extension_ui_response", id: msg.id, cancelled: true });
  }
}
async function main() {
  if (scenario === "e1") {
    // Send get_state immediately, before any output, to see whether it blocks on trust resolution.
    send({ id: "s1", type: "get_state" });
    try {
      await waitFor((m) => m.type === "response" && m.id === "s1", 20000);
    } catch {
      log("get_state timeout");
    }
    send({ id: "c1", type: "get_commands" });
    try {
      await waitFor((m) => m.type === "response" && m.id === "c1");
    } catch {
      log("get_commands timeout");
    }
  } else if (scenario === "e2") {
    send({ id: "s1", type: "get_state" });
    await waitFor((m) => m.type === "response" && m.id === "s1", 20000);
    send({ id: "1", type: "prompt", message: "/spike-wait" });
    await waitFor((m) => m.type === "response" && m.id === "1", 10000);
    await new Promise((r) => setTimeout(r, 3500));
    send({ id: "2", type: "prompt", message: "/spike-throw" });
    await waitFor((m) => m.type === "response" && m.id === "2", 10000);
    await new Promise((r) => setTimeout(r, 300));
  }
  child.stdin.end();
  child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 2000);
}
main().catch((e) => {
  log(`driver error ${e}`);
  child.kill();
  process.exit(1);
});
