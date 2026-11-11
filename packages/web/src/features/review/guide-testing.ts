/** A ready PR guide for the Guide tab's tests. */

import type { PrGuideUnit } from "@pi-code/protocol";
import type { ReadyGuide } from "./guide-model";

export const GUIDE_KEY = `o/r#12@${"a".repeat(40)}..${"b".repeat(40)}`;

const header = (path: string, extra = "index 1..2 100644", from = `a/${path}`) =>
  `diff --git a/${path} b/${path}\n${extra}\n--- ${from}\n+++ b/${path}\n`;

/** `src/a.ts` at the base: `line 1` … `line 15`; the head changes lines 2 and 11. */
export const A_BASE = `${Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
export const A_HEAD = A_BASE.replace("line 2\n", "LINE 2\n").replace("line 11\n", "LINE 11\n");

const aFile = { path: "src/a.ts", status: "modified" as const, additions: 2, deletions: 2 };

/** Every unit of the PR diff: two hunks of `src/a.ts`, an added `src/b.ts`, a binary logo. */
export const UNITS: Record<string, PrGuideUnit> = {
  "src/a.ts#1": {
    ...aFile,
    patch: `${header("src/a.ts")}@@ -1,3 +1,3 @@\n line 1\n-line 2\n+LINE 2\n line 3\n`,
  },
  "src/a.ts#2": {
    ...aFile,
    patch: `${header("src/a.ts")}@@ -10,3 +10,3 @@\n line 10\n-line 11\n+LINE 11\n line 12\n`,
  },
  "src/b.ts#1": {
    path: "src/b.ts",
    status: "added",
    additions: 2,
    deletions: 0,
    patch: `${header("src/b.ts", "new file mode 100644", "/dev/null")}@@ -0,0 +1,2 @@\n+x\n+y\n`,
  },
  "logo.png#0": {
    path: "logo.png",
    status: "added",
    additions: 0,
    deletions: 0,
    noHunks: "binary",
  },
};

export function readyGuide(patch: Partial<ReadyGuide> = {}): ReadyGuide {
  return {
    key: GUIDE_KEY,
    state: "ready",
    id: "0123456789abcdef",
    guide: {
      version: 1,
      repo: "o/r",
      number: 12,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      sections: [
        {
          title: "Core change",
          explanation: "Why it **matters**.",
          hunks: ["src/a.ts#2", "src/b.ts#1", "src/a.ts#1"],
        },
        { title: "Follow-up", explanation: "The second look.", hunks: ["src/a.ts#2"] },
      ],
      other: ["logo.png#0"],
    },
    units: UNITS,
    oldRev: "aaaaaaa",
    newRev: "bbbbbbb",
    ...patch,
  };
}
