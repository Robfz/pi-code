/**
 * The PR diff's hunks as the PR guide names them (design/11-pr-guide.md, "Hunks"): each file's
 * patch split at its `@@` headers, every hunk with its id, and the labelled diff the guide job
 * reads, where each hunk follows a line naming its id.
 */
import { type GitFileDiff, guideFileId, guideHunkId, oneLine } from "@pi-code/protocol";

export interface DiffHunk {
  /** `<path>#<n>`, n 1-based within the file. */
  id: string;
  /** From the `@@` header line to the hunk's end, newline-terminated. */
  text: string;
}

/** Why a changed file has no hunks. */
export type NoHunksReason = "binary" | "tooLarge" | "noContent";

export interface GuideFile {
  path: string;
  oldPath?: string;
  status: GitFileDiff["status"];
  /** Empty for a file without hunks. */
  hunks: DiffHunk[];
  /** Set for a file without hunks, listed as a whole by its file-level id (`<path>#0`). */
  noHunks?: NoHunksReason;
}

/**
 * Splits a file's patch into its hunks; header lines are dropped. A type change (a symlink
 * becoming a file) is a deletion and an addition, two `diff --git` sections in one patch, so a
 * section's header also ends the hunk before it.
 */
function patchHunks(path: string, patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: string[] | undefined;
  const flush = () => {
    if (current === undefined) return;
    hunks.push({ id: guideHunkId(path, hunks.length + 1), text: `${current.join("\n")}\n` });
  };
  const lines = patch.endsWith("\n") ? patch.slice(0, -1).split("\n") : patch.split("\n");
  for (const line of lines) {
    // Content lines start with ` `, `+`, `-` or `\`, so only a hunk header starts with `@@`.
    if (line.startsWith("@@ ")) {
      flush();
      current = [line];
    } else if (line.startsWith("diff --git ")) {
      flush();
      current = undefined;
    } else current?.push(line);
  }
  flush();
  return hunks;
}

/** The PR diff's files with their hunks, in diff order. */
export function splitHunks(files: readonly GitFileDiff[]): GuideFile[] {
  return files.map((file) => {
    const hunks = file.patch === undefined ? [] : patchHunks(file.path, file.patch);
    const guideFile: GuideFile = { path: file.path, status: file.status, hunks };
    if (file.oldPath !== undefined) guideFile.oldPath = file.oldPath;
    if (hunks.length === 0) {
      guideFile.noHunks = file.binary ? "binary" : file.tooLarge ? "tooLarge" : "noContent";
    }
    return guideFile;
  });
}

/** The id of every hunk, in diff order: what a guide's sections may reference. */
export function hunkIds(files: readonly GuideFile[]): string[] {
  return files.flatMap((file) => file.hunks.map((hunk) => hunk.id));
}

/** Every unit of the diff in diff order: the hunk ids, and the file-level id of a file without. */
export function unitIds(files: readonly GuideFile[]): string[] {
  return files.flatMap((file) =>
    file.noHunks === undefined ? file.hunks.map((hunk) => hunk.id) : [guideFileId(file.path)],
  );
}

const NO_HUNKS: Record<NoHunksReason, string> = {
  binary: "binary",
  tooLarge: "too large to diff",
  noContent: "no content change",
};

/**
 * The labelled diff: per file a `## <path> (<status>)` line, then each hunk after a `### <id>`
 * line. Diff lines start with ` `, `+`, `-`, `\` or `@@`, so a `#` line can't be one of them. Files
 * without hunks are named with the reason and can't be referenced.
 */
export function labelledDiff(files: readonly GuideFile[]): string {
  return files
    .map((file) => {
      const path =
        file.oldPath === undefined
          ? oneLine(file.path)
          : `${oneLine(file.oldPath)} → ${oneLine(file.path)}`;
      if (file.noHunks !== undefined) {
        return `## ${path} (${file.status}, ${NO_HUNKS[file.noHunks]}: no hunks, listed under Other changes)\n`;
      }
      const hunks = file.hunks.map((hunk) => `### ${hunk.id}\n${hunk.text}`).join("");
      return `## ${path} (${file.status})\n${hunks}`;
    })
    .join("\n");
}
