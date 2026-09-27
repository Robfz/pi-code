import { describe, expect, it } from "vitest";
import { fixtureEditPatch } from "@/tools/testing";
import { allAddedPatch, countPatchLines, parsePatch } from "./parse-patch";

const fixturePatch = fixtureEditPatch;

const GIT_PATCH = `diff --git a/src/app.ts b/src/app.ts
index 3b18e51..a9c2f10 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 import { a } from "./a";
-const x = 1;
+const x = 2;
+const y = 3;
 export { x };
 // end
@@ -10,3 +11,2 @@ function f() {
 keep
-drop
 keep
`;

describe("parsePatch", () => {
  it("parses the edit tool's patch from the tool-calls fixture", () => {
    const patch = fixturePatch();
    const parsed = parsePatch(patch);
    expect(parsed).toMatchObject({
      oldName: "notes.txt",
      newName: "notes.txt",
      additions: 1,
      deletions: 1,
      hunkCount: 1,
      lineCount: 3,
      binary: false,
    });
    expect(parsed.hunks).toEqual([
      "--- notes.txt\n+++ notes.txt\n@@ -1,2 +1,2 @@\n-I like apple pie.\n+I like banana bread.\n Apples are red.\n",
    ]);
    expect(countPatchLines(patch)).toEqual({ additions: 1, deletions: 1 });
  });

  it("parses git output with several hunks and strips a/ b/ prefixes", () => {
    const parsed = parsePatch(GIT_PATCH);
    expect(parsed.oldName).toBe("src/app.ts");
    expect(parsed.newName).toBe("src/app.ts");
    expect(parsed.hunkCount).toBe(2);
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(2);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0]).toMatch(/^--- src\/app\.ts\n\+\+\+ src\/app\.ts\n@@ -1,4 \+1,5 @@/);
  });

  it("doesn't mistake removed lines that look like headers for a new file", () => {
    const parsed = parsePatch(
      "--- a/x.md\n+++ b/x.md\n@@ -1,2 +1,1 @@\n--- a heading rule\n kept\n",
    );
    expect(parsed.deletions).toBe(1);
    expect(parsed.hunks).toHaveLength(1);
  });

  it("splits multi-file git output into one diff per file", () => {
    const two = `${GIT_PATCH}diff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+hello\n`;
    const parsed = parsePatch(two);
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[1]).toBe("--- /dev/null\n+++ b.txt\n@@ -0,0 +1 @@\n+hello\n");
    expect(parsed.additions).toBe(3);
  });

  it("synthesizes a header for bare hunks", () => {
    const parsed = parsePatch("@@ -1 +1 @@\n-a\n+b\n", "x.ts");
    expect(parsed.hunks[0]).toBe("--- x.ts\n+++ x.ts\n@@ -1 +1 @@\n-a\n+b\n");
  });

  it("keeps 'No newline at end of file' markers", () => {
    const parsed = parsePatch("--- a\n+++ b\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n");
    expect(parsed.hunks[0]).toContain("\\ No newline at end of file");
    expect(parsed.lineCount).toBe(2);
  });

  it("detects binary patches", () => {
    const parsed = parsePatch(
      "diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n",
    );
    expect(parsed.binary).toBe(true);
    expect(parsed.hunks).toEqual([]);
  });
});

describe("allAddedPatch", () => {
  it("adds every line of the content", () => {
    const patch = allAddedPatch("new.txt", "one\ntwo\n");
    expect(patch).toBe("--- /dev/null\n+++ new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n");
    expect(countPatchLines(patch)).toEqual({ additions: 2, deletions: 0 });
  });

  it("is empty for empty content", () => {
    expect(allAddedPatch("e.txt", "")).toBe("");
  });
});
