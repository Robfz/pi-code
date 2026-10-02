/**
 * Deleting session files, pi-code's only write to pi's agent dir (design/06-worktrees.md,
 * "`DELETE /api/worktrees`").
 */
import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";

const TRASH_TIMEOUT_MS = 10_000;

/** Runs `<command> <file>` without a shell, killing it after `timeoutMs`. */
function runTrash(
  command: string,
  file: string,
  timeoutMs: number,
): Promise<"done" | "failed" | "timed_out"> {
  return new Promise((resolve) => {
    const child = spawn(command, [file], {
      stdio: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    child.on("error", () => resolve("failed"));
    // `killed`: only the timeout kills it from here.
    child.on("close", (code) =>
      resolve(child.killed ? "timed_out" : code === 0 ? "done" : "failed"),
    );
  });
}

async function unlinkIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (e) {
    // Gone already: trash moved it despite failing.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * Deletes session files one at a time like pi's TUI: `trash <file>`, done when it exits 0 or the
 * file is gone, else `unlink`. After a `trash` timeout, unlinks the remaining files directly.
 * Attempts every file; returns those that survived.
 */
export async function deleteSessionFiles(
  files: readonly string[],
  trashCommand = "trash",
  timeoutMs = TRASH_TIMEOUT_MS,
): Promise<string[]> {
  let trash: string | undefined = trashCommand;
  const failed: string[] = [];
  for (const file of files) {
    try {
      const result = trash === undefined ? "failed" : await runTrash(trash, file, timeoutMs);
      // A hung `trash` would hang as long for every remaining file.
      if (result === "timed_out") trash = undefined;
      if (result !== "done") await unlinkIfPresent(file);
    } catch (e) {
      console.warn(`[sessions] could not delete ${file}: ${(e as Error).message}`);
      failed.push(file);
    }
  }
  return failed;
}
