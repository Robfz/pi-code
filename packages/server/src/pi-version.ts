import { execFile } from "node:child_process";

/**
 * Returns a function reporting `pi --version`, run once and cached. A failed probe reports
 * `"unknown"` and is retried on the next call.
 */
export function piVersionProbe(piBin: string): () => Promise<string> {
  let cached: Promise<string> | undefined;
  return () => {
    cached ??= new Promise<string>((resolve, reject) => {
      execFile(piBin, ["--version"], { timeout: 10_000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim().split("\n")[0]?.trim() || "unknown");
      });
    });
    return cached.catch(() => {
      cached = undefined;
      return "unknown";
    });
  };
}
