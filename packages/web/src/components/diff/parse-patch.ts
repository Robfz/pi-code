/**
 * Unified patch parsing for the diff viewer (`@git-diff-view/react` takes one full single-file
 * diff text per entry of `hunks`, header included).
 */

export interface ParsedPatch {
  /** File name from the `---` line (`null` for `/dev/null`). */
  oldName: string | null;
  /** File name from the `+++` line (`null` for `/dev/null`). */
  newName: string | null;
  /** Diff texts in the viewer's `hunks` format: one per file, `---`/`+++` header included. */
  hunks: string[];
  additions: number;
  deletions: number;
  /** Number of hunk (`@@`) sections. */
  hunkCount: number;
  /** Diff body lines (context, added, removed), for the large-patch guard. */
  lineCount: number;
  binary: boolean;
}

function stripPrefix(name: string): string | null {
  // `--- a/path\t2024-01-01 ...` → `path`; `/dev/null` → null.
  const clean = name.replace(/\t.*$/, "").trim();
  if (clean === "/dev/null") return null;
  return clean.replace(/^[ab]\//, "");
}

/** `+n −m` counts of a unified patch (header lines excluded). */
export function countPatchLines(patch: string): { additions: number; deletions: number } {
  const { additions, deletions } = parsePatch(patch);
  return { additions, deletions };
}

/**
 * Parse a unified patch (git or plain `diff -u` style, possibly without a `---`/`+++` header).
 * Handles one file; for multi-file git output each `diff --git` section becomes its own entry
 * in `hunks`, while names describe the first file.
 */
export function parsePatch(patch: string, fallbackName = "file"): ParsedPatch {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();

  const files: { oldName: string | null; newName: string | null; body: string[] }[] = [];
  let current: (typeof files)[number] | undefined;
  let inHunk = false;
  let additions = 0;
  let deletions = 0;
  let hunkCount = 0;
  let lineCount = 0;
  let binary = false;
  let pendingOld: string | null | undefined;
  let oldLeft = 0;
  let newLeft = 0;

  const startFile = () => {
    current = { oldName: null, newName: null, body: [] };
    files.push(current);
    inHunk = false;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      startFile();
      pendingOld = undefined;
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      pendingOld = stripPrefix(line.slice(4));
      continue;
    }
    if (!inHunk && line.startsWith("+++ ") && pendingOld !== undefined) {
      if (!current || current.body.length > 0) startFile();
      const file = current as (typeof files)[number];
      file.oldName = pendingOld;
      file.newName = stripPrefix(line.slice(4));
      pendingOld = undefined;
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      binary = true;
      continue;
    }
    if (!inHunk && line.startsWith("@@")) {
      if (!current) startFile();
      const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      oldLeft = m ? Number(m[1] ?? 1) : Number.POSITIVE_INFINITY;
      newLeft = m ? Number(m[2] ?? 1) : Number.POSITIVE_INFINITY;
      inHunk = oldLeft > 0 || newLeft > 0;
      hunkCount++;
      current?.body.push(line);
      continue;
    }
    if (line.startsWith("\\") && current && current.body.length > 0) {
      // "\ No newline at end of file"
      current.body.push(line);
      continue;
    }
    if (!inHunk || !current) continue;
    if (line.startsWith("+")) {
      additions++;
      newLeft--;
    } else if (line.startsWith("-")) {
      deletions++;
      oldLeft--;
    } else if (line.startsWith(" ") || line === "") {
      oldLeft--;
      newLeft--;
    } else {
      inHunk = false;
      continue;
    }
    lineCount++;
    current.body.push(line);
    if (oldLeft <= 0 && newLeft <= 0) inHunk = false;
  }

  const withBody = files.filter((f) => f.body.length > 0);
  const hunks = withBody.map((f) => {
    const oldHeader = f.oldName ?? (f.newName === null ? fallbackName : "/dev/null");
    const newHeader = f.newName ?? (f.oldName === null ? fallbackName : "/dev/null");
    return [`--- ${oldHeader}`, `+++ ${newHeader}`, ...f.body, ""].join("\n");
  });
  const first = withBody[0] ?? files[0];
  return {
    oldName: first?.oldName ?? null,
    newName: first?.newName ?? null,
    hunks,
    additions,
    deletions,
    hunkCount,
    lineCount,
    binary,
  };
}

/** A new-file patch where every line of `content` is added. */
export function allAddedPatch(path: string, content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return "";
  return [
    "--- /dev/null",
    `+++ ${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

/** An all-context patch showing every line of `content`, for viewing a whole file. */
export function fileAsPatch(path: string, content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return "";
  return [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -1,${lines.length} +1,${lines.length} @@`,
    ...lines.map((line) => ` ${line}`),
    "",
  ].join("\n");
}
