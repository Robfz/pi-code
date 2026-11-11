/**
 * The PR diff's hunks as the PR guide names them (design/11-pr-guide.md, "Hunks"): each file's
 * patch split at its `@@` headers, every hunk with its id, and the labelled diff the guide job
 * reads, where each hunk follows a line naming its id.
 */
import {
  type GitFileDiff,
  guideFileId,
  guideHunkId,
  oneLine,
  type PrGuideNoHunks,
  type PrGuideUnit,
} from "@pi-code/protocol";

export interface DiffHunk {
  /** `<path>#<n>`, n 1-based within the file. */
  id: string;
  /** From the `@@` header line to the hunk's end, newline-terminated. */
  text: string;
}

export interface GuideFile {
  path: string;
  oldPath?: string;
  status: GitFileDiff["status"];
  /** Empty for a file without hunks. */
  hunks: DiffHunk[];
  /** Set for a file without hunks, listed as a whole by its file-level id (`<path>#0`). */
  noHunks?: PrGuideNoHunks;
}

/** A hunk of a patch, before it is named. */
interface PatchHunk {
  /** The header lines of its `diff --git` section (`diff --git`, `index`, `---`, `+++`). */
  header: string;
  /** From the `@@` header line to the hunk's end, newline-terminated. */
  text: string;
}

/**
 * Splits a file's patch into its hunks. A type change (a symlink becoming a file) is a deletion
 * and an addition, two `diff --git` sections in one patch, so a section's header also ends the
 * hunk before it, and starts the header of the hunks after it.
 */
function patchHunks(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let header: string[] = [];
  let current: string[] | undefined;
  const flush = () => {
    if (current === undefined) return;
    const head = header.length === 0 ? "" : `${header.join("\n")}\n`;
    hunks.push({ header: head, text: `${current.join("\n")}\n` });
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
      header = [line];
    } else if (current !== undefined) current.push(line);
    else header.push(line);
  }
  flush();
  return hunks;
}

function noHunksReason(file: GitFileDiff): PrGuideNoHunks {
  return file.binary ? "binary" : file.tooLarge ? "tooLarge" : "noContent";
}

/** The PR diff's files with their hunks, in diff order. */
export function splitHunks(files: readonly GitFileDiff[]): GuideFile[] {
  return files.map((file) => {
    const hunks = (file.patch === undefined ? [] : patchHunks(file.patch)).map((hunk, i) => ({
      id: guideHunkId(file.path, i + 1),
      text: hunk.text,
    }));
    const guideFile: GuideFile = { path: file.path, status: file.status, hunks };
    if (file.oldPath !== undefined) guideFile.oldPath = file.oldPath;
    if (hunks.length === 0) guideFile.noHunks = noHunksReason(file);
    return guideFile;
  });
}

/**
 * The units `ids` name, as the Guide tab renders them: each hunk with its own unified patch (its
 * section's header, then the hunk), each file without hunks with the reason. `undefined` when an
 * id isn't a unit of `files`.
 */
export function guideUnits(
  files: readonly GitFileDiff[],
  ids: Iterable<string>,
): Record<string, PrGuideUnit> | undefined {
  const all = new Map<string, PrGuideUnit>();
  for (const file of files) {
    const hunks = file.patch === undefined ? [] : patchHunks(file.patch);
    let additions = 0;
    let deletions = 0;
    for (const { text } of hunks) {
      for (const line of text.split("\n").slice(1)) {
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
      }
    }
    const unit = {
      path: file.path,
      ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
      status: file.status,
      additions,
      deletions,
    };
    if (hunks.length === 0) {
      all.set(guideFileId(file.path), { ...unit, noHunks: noHunksReason(file) });
    }
    hunks.forEach((hunk, i) => {
      all.set(guideHunkId(file.path, i + 1), { ...unit, patch: `${hunk.header}${hunk.text}` });
    });
  }
  const units: Record<string, PrGuideUnit> = {};
  for (const id of ids) {
    const unit = all.get(id);
    if (unit === undefined) return undefined;
    units[id] = unit;
  }
  return units;
}

/** A hunk's line ranges, from its `@@ -a,b +c,d @@` header (a count of 1 may be left out). */
export function hunkRanges(
  text: string,
): { oldStart: number; oldLines: number; newStart: number; newLines: number } | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/m.exec(text);
  if (match === null) return undefined;
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
  };
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

/** How a file without hunks is described, in the labelled diff and the guide's prompt. */
export const NO_HUNKS: Record<PrGuideNoHunks, string> = {
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
