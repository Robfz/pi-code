import { mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitFileDiff, PrGuideUnit } from "@pi-code/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitDiff } from "../git/git.ts";
import { git } from "../testing/layout-repo.ts";
import {
  type GuideFile,
  guideUnits,
  hunkIds,
  hunkRanges,
  labelledDiff,
  splitHunks,
  unitIds,
} from "./guide-hunks.ts";

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i}`);
const text = (l: string[]) => `${l.join("\n")}\n`;
const patchOf = (unit: PrGuideUnit | undefined) =>
  unit !== undefined && "patch" in unit ? unit.patch : undefined;

let root: string;
let diffFiles: GitFileDiff[];
let files: GuideFile[];

/** One PR diff with every kind of change, split. */
beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-hunks-")));
  git(root, "init", "-q", "-b", "main");
  const two = lines(30);
  writeFileSync(join(root, "two.txt"), text(two));
  writeFileSync(join(root, "gone.txt"), "bye\n");
  writeFileSync(join(root, "old-name.txt"), text(lines(20, "kept")));
  writeFileSync(join(root, "eof.txt"), "a\nb");
  writeFileSync(join(root, "moved.txt"), text(lines(10, "same")));
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD").trim();

  writeFileSync(
    join(root, "two.txt"),
    text(two.map((l, i) => (i === 2 || i === 25 ? `${l}!` : l))),
  );
  unlinkSync(join(root, "gone.txt"));
  unlinkSync(join(root, "old-name.txt"));
  writeFileSync(
    join(root, "new-name.txt"),
    text(lines(20, "kept").map((l, i) => (i === 10 ? "changed" : l))),
  );
  writeFileSync(join(root, "eof.txt"), "a\nc");
  git(root, "mv", "moved.txt", "moved-to.txt");
  writeFileSync(join(root, "added.txt"), "new\n");
  writeFileSync(join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "head");
  const head = git(root, "rev-parse", "HEAD").trim();

  diffFiles = (await gitDiff(root, { range: { from: base, to: head } })).files;
  files = splitHunks(diffFiles);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const file = (path: string) => {
  const found = files.find((f) => f.path === path);
  if (!found) throw new Error(`no ${path} in ${files.map((f) => f.path)}`);
  return found;
};

describe("splitHunks", () => {
  it("splits a file's patch at its @@ headers, numbering hunks from 1", () => {
    const { hunks, noHunks } = file("two.txt");
    expect(noHunks).toBeUndefined();
    expect(hunks.map((h) => h.id)).toEqual(["two.txt#1", "two.txt#2"]);
    expect(hunks[0]?.text).toMatch(/^@@ -1,6 \+1,6 @@\n line 0\n/);
    expect(hunks[0]?.text).toContain("-line 2\n+line 2!\n");
    expect(hunks[0]?.text).not.toContain("line 25");
    expect(hunks[1]?.text).toMatch(/^@@ -23,7 \+23,7 @@/);
    expect(hunks[1]?.text.endsWith(" line 28\n")).toBe(true);
  });

  it("names a renamed file's hunks by its new path", () => {
    const renamed = file("new-name.txt");
    expect(renamed).toMatchObject({ status: "renamed", oldPath: "old-name.txt" });
    expect(renamed.hunks.map((h) => h.id)).toEqual(["new-name.txt#1"]);
  });

  it("keeps added and deleted files as one hunk", () => {
    expect(file("added.txt").hunks).toEqual([{ id: "added.txt#1", text: "@@ -0,0 +1 @@\n+new\n" }]);
    expect(file("gone.txt").hunks).toEqual([{ id: "gone.txt#1", text: "@@ -1 +0,0 @@\n-bye\n" }]);
  });

  it("keeps no-newline-at-end-of-file markers in their hunk", () => {
    expect(file("eof.txt").hunks).toEqual([
      {
        id: "eof.txt#1",
        text: "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n",
      },
    ]);
  });

  it("gives binary files and pure renames no hunks", () => {
    expect(file("image.bin")).toMatchObject({ hunks: [], noHunks: "binary" });
    expect(file("moved-to.txt")).toMatchObject({ hunks: [], noHunks: "noContent" });
  });

  it("ends a type change's first hunk at its second section's header", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-hunks-type-")));
    try {
      git(repo, "init", "-q", "-b", "main");
      symlinkSync("target", join(repo, "link"));
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "base");
      const base = git(repo, "rev-parse", "HEAD").trim();
      unlinkSync(join(repo, "link"));
      writeFileSync(join(repo, "link"), "now a file\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "head");
      const head = git(repo, "rev-parse", "HEAD").trim();
      const diff = await gitDiff(repo, { range: { from: base, to: head } });
      expect(splitHunks(diff.files)[0]?.hunks).toEqual([
        { id: "link#1", text: "@@ -1 +0,0 @@\n-target\n\\ No newline at end of file\n" },
        { id: "link#2", text: "@@ -0,0 +1 @@\n+now a file\n" },
      ]);
      // Each hunk's patch carries its own section's header.
      const units = guideUnits(diff.files, ["link#1", "link#2"]);
      expect(patchOf(units?.["link#1"])).toMatch(
        /^diff --git a\/link b\/link\ndeleted file mode 120000\n.*\n--- a\/link\n\+\+\+ \/dev\/null\n@@ -1 \+0,0 @@\n/,
      );
      expect(patchOf(units?.["link#2"])).toMatch(
        /^diff --git a\/link b\/link\nnew file mode 100644\n.*\n--- \/dev\/null\n\+\+\+ b\/link\n@@ -0,0 \+1 @@\n\+now a file\n$/,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("gives too-large files no hunks", () => {
    const large: GitFileDiff = {
      path: "big.txt",
      status: "modified",
      binary: false,
      tooLarge: true,
    };
    expect(splitHunks([large])).toEqual([
      { path: "big.txt", status: "modified", hunks: [], noHunks: "tooLarge" },
    ]);
  });
});

describe("hunk and unit ids", () => {
  it("lists hunks in diff order, and file-level ids for files without hunks", () => {
    expect(hunkIds(files)).toEqual([
      "added.txt#1",
      "eof.txt#1",
      "gone.txt#1",
      "new-name.txt#1",
      "two.txt#1",
      "two.txt#2",
    ]);
    expect(unitIds(files)).toEqual([
      "added.txt#1",
      "eof.txt#1",
      "gone.txt#1",
      "image.bin#0",
      "moved-to.txt#0",
      "new-name.txt#1",
      "two.txt#1",
      "two.txt#2",
    ]);
  });
});

describe("guideUnits", () => {
  it("resolves each hunk to its file and a patch of the hunk alone", () => {
    const units = guideUnits(diffFiles, ["two.txt#2", "new-name.txt#1", "added.txt#1"]);
    const second = file("two.txt").hunks[1]?.text;
    expect(units).toEqual({
      "two.txt#2": {
        path: "two.txt",
        status: "modified",
        additions: 2,
        deletions: 2,
        patch: expect.stringMatching(
          /^diff --git a\/two.txt b\/two.txt\nindex .*\n--- a\/two.txt\n\+\+\+ b\/two.txt\n@@ -23,7/,
        ),
      },
      "new-name.txt#1": {
        path: "new-name.txt",
        oldPath: "old-name.txt",
        status: "renamed",
        additions: 1,
        deletions: 1,
        patch: expect.stringContaining("rename from old-name.txt\nrename to new-name.txt\n"),
      },
      "added.txt#1": {
        path: "added.txt",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: expect.stringMatching(
          /\n--- \/dev\/null\n\+\+\+ b\/added.txt\n@@ -0,0 \+1 @@\n\+new\n$/,
        ),
      },
    });
    expect(patchOf(units?.["two.txt#2"])?.endsWith(second as string)).toBe(true);
    expect(patchOf(units?.["two.txt#2"])).not.toContain("line 2!");
  });

  it("gives files without hunks the reason", () => {
    expect(guideUnits(diffFiles, ["image.bin#0", "moved-to.txt#0"])).toEqual({
      "image.bin#0": {
        path: "image.bin",
        status: "added",
        additions: 0,
        deletions: 0,
        noHunks: "binary",
      },
      "moved-to.txt#0": {
        path: "moved-to.txt",
        oldPath: "moved.txt",
        status: "renamed",
        additions: 0,
        deletions: 0,
        noHunks: "noContent",
      },
    });
  });

  it("resolves nothing when an id isn't a unit of the diff", () => {
    expect(guideUnits(diffFiles, ["two.txt#1", "two.txt#3"])).toBeUndefined();
    expect(guideUnits(diffFiles, ["two.txt#0"])).toBeUndefined();
  });
});

describe("hunkRanges", () => {
  it("reads both sides' ranges, a left-out count being 1", () => {
    expect(hunkRanges("@@ -23,7 +23,8 @@ ctx\n")).toEqual({
      oldStart: 23,
      oldLines: 7,
      newStart: 23,
      newLines: 8,
    });
    expect(hunkRanges("diff --git a/x b/x\n@@ -1 +0,0 @@\n-x\n")).toEqual({
      oldStart: 1,
      oldLines: 1,
      newStart: 0,
      newLines: 0,
    });
    expect(hunkRanges("no header")).toBeUndefined();
  });
});

describe("labelledDiff", () => {
  it("labels each hunk with its id under its file", () => {
    const out = labelledDiff([file("two.txt"), file("new-name.txt"), file("image.bin")]);
    const two = file("two.txt").hunks;
    expect(out).toBe(
      [
        `## two.txt (modified)\n### two.txt#1\n${two[0]?.text}### two.txt#2\n${two[1]?.text}`,
        `## old-name.txt → new-name.txt (renamed)\n### new-name.txt#1\n${file("new-name.txt").hunks[0]?.text}`,
        "## image.bin (added, binary: no hunks, listed under Other changes)\n",
      ].join("\n"),
    );
  });

  it("keeps a path with a newline on its line", () => {
    const out = labelledDiff(
      splitHunks([
        {
          path: "a\nb",
          status: "added",
          binary: false,
          tooLarge: false,
          patch: "@@ -0,0 +1 @@\n+x\n",
        },
      ]),
    );
    expect(out).toBe("## a\\u000ab (added)\n### a\\u000ab#1\n@@ -0,0 +1 @@\n+x\n");
  });
});
