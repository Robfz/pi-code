/**
 * The `pi` the e2e server runs (`PI_CODE_PI_BIN` points at a shell shim that execs this file):
 * replays the fake-pi fixture chosen for the conversation's project dir.
 *
 * The control file `$E2E_CONTROL_DIR/<basename of cwd>.json` holds `{ fixture, speed }`. pi's
 * own arguments (`--mode rpc --extension … [--session …]`) are not forwarded: the fake takes its
 * first non-flag argument as the fixture. `--version` answers right away (`/api/health`).
 *
 * Run by plain Node (type stripping): no TypeScript-only runtime syntax.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { FAKE_PI_PATH } from "../../test/fake-pi.ts";

export interface Control {
  /** Absolute path of the fixture to replay. */
  fixture: string;
  /** fake-pi `--speed`: 0 instant, 1 recorded spacing, N N× faster. */
  speed: number;
}

/** Where the wrapper looks for the control of a project dir. */
export function controlFile(controlDir: string, cwd: string): string {
  return join(controlDir, `${basename(cwd)}.json`);
}

function readControl(): Control {
  const dir = process.env.E2E_CONTROL_DIR;
  if (!dir) throw new Error("E2E_CONTROL_DIR is not set");
  const file = controlFile(dir, process.cwd());
  const control = JSON.parse(readFileSync(file, "utf8")) as Partial<Control>;
  if (typeof control.fixture !== "string" || typeof control.speed !== "number") {
    throw new Error(`${file}: expected { fixture: string, speed: number }`);
  }
  return { fixture: control.fixture, speed: control.speed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--version")) {
    console.log("0.0.0-e2e");
    process.exit(0);
  }
  let control: Control;
  try {
    control = readControl();
  } catch (e) {
    // The agent shows as exited, with this line in its stderr tail.
    console.error(`[e2e pi] no fixture for ${process.cwd()}: ${(e as Error).message}`);
    process.exit(1);
  }
  const child = spawn(
    process.execPath,
    [FAKE_PI_PATH, control.fixture, `--speed=${control.speed}`],
    {
      stdio: "inherit",
    },
  );
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
