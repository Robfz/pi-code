/**
 * Once per run: builds the web app (the server serves `packages/web/dist`), makes the run's temp
 * root with the `pi` and `trash` shims, and checks the generated fixtures.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFixture } from "./harness/fixtures/check.ts";
import { type FixtureKind, generateFixture } from "./harness/fixtures/generate.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const KINDS: FixtureKind[] = ["short-answer", "long-stream", "tool-storm", "history"];

function shim(file: string, script: string): void {
  writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

export default function globalSetup(): void {
  const build = spawnSync("pnpm", ["--filter", "@pi-code/web", "build"], {
    cwd: REPO,
    encoding: "utf8",
  });
  if (build.status !== 0 || !existsSync(join(REPO, "packages/web/dist/index.html"))) {
    throw new Error(`web build failed (exit ${build.status}):\n${build.stdout}\n${build.stderr}`);
  }

  // Real path: the server compares realpaths (macOS tmpdir is behind the /var symlink).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-e2e-")));
  // Inherited by the workers, and read by the teardown, which runs even if the rest fails.
  process.env.E2E_ROOT = root;
  const bin = join(root, "bin");
  mkdirSync(bin);
  const wrapper = realpathSync(fileURLToPath(new URL("./harness/pi-wrapper.ts", import.meta.url)));
  shim(join(bin, "pi"), `exec "${process.execPath}" "${wrapper}" "$@"`);
  shim(join(bin, "trash"), 'exec rm -f -- "$@"');

  for (const kind of KINDS) {
    const opts = {
      cwd: root,
      sessionFile: join(root, "s.jsonl"),
      sessionId: "check",
      prompt: "check",
    };
    try {
      checkFixture(generateFixture(kind, opts), opts);
    } catch (e) {
      throw new Error(`generated ${kind} fixture: ${(e as Error).message}`);
    }
  }
}
