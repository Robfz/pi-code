import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * pi's session file for a cwd:
 * `<sessions>/--<cwd with / as ->--/<ISO time with - for : and .>_<id>.jsonl`.
 */
export function sessionFileFor(sessionsDir: string, cwd: string, id: string, at: Date): string {
  return join(
    sessionsDir,
    `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`,
    `${at.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`,
  );
}

/**
 * Writes a minimal pi session file (v3 header, one user message) so the catalog lists it: the
 * sessions page, the picker and the sidebar's folder groups. Its transcript comes from the
 * fixture once the session is opened; the fake pi never writes session files.
 */
export function writeSessionFile(
  file: string,
  session: { id: string; cwd: string; prompt: string; at: Date },
): void {
  const time = session.at.getTime();
  const iso = (offset: number) => new Date(time + offset).toISOString();
  const records = [
    { type: "session", version: 3, id: session.id, timestamp: iso(0), cwd: session.cwd },
    {
      type: "message",
      id: "s0000001",
      parentId: null,
      timestamp: iso(1000),
      message: {
        role: "user",
        content: [{ type: "text", text: session.prompt }],
        timestamp: time + 1000,
      },
    },
  ];
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
}
