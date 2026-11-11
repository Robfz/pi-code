import type { PrGuideUnit } from "@pi-code/protocol";
import { describe, expect, it } from "vitest";
import { EXPAND_MAX_FILES, EXPAND_MAX_LINES } from "./file-card";
import { currentItem, expandCards, guideItems } from "./guide-model";
import { readyGuide, UNITS } from "./guide-testing";

describe("guideItems", () => {
  it("groups each section's hunks by file, files in first-appearance order, hunks in file order", () => {
    const [core, followUp, other] = guideItems(readyGuide());
    expect(core).toMatchObject({ title: "Core change", explanation: "Why it **matters**." });
    expect(core?.cards.map((card) => card.path)).toEqual(["src/a.ts", "src/b.ts"]);
    const [a, b] = core?.cards ?? [];
    expect(a).toMatchObject({ status: "modified", additions: 2, deletions: 2, expandable: true });
    expect(a?.patch).toBe(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1..2 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,3 @@",
        " line 1",
        "-line 2",
        "+LINE 2",
        " line 3",
        "@@ -10,3 +10,3 @@",
        " line 10",
        "-line 11",
        "+LINE 11",
        " line 12",
        "",
      ].join("\n"),
    );
    expect(b).toMatchObject({ status: "added", expandable: false });

    // A section holding some of a file's hunks.
    expect(followUp?.cards).toHaveLength(1);
    expect(followUp?.cards[0]).toMatchObject({ path: "src/a.ts", expandable: false });
    expect(followUp?.cards[0]?.patch).not.toContain("line 2");

    expect(other).toEqual({
      title: "Other changes",
      cards: [
        {
          key: "logo.png#0",
          path: "logo.png",
          status: "added",
          additions: 0,
          deletions: 0,
          noHunks: "binary",
          expandable: false,
        },
      ],
    });
  });

  it("has no Other changes when every unit is in a section", () => {
    const guide = readyGuide();
    const items = guideItems({ ...guide, guide: { ...guide.guide, other: [] } });
    expect(items.map((item) => item.title)).toEqual(["Core change", "Follow-up"]);
  });

  it("keeps a rename's old path and a type change's two sections apart, expanding the rename only", () => {
    const rename: PrGuideUnit = {
      path: "new.ts",
      oldPath: "old.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
      patch:
        "diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n",
    };
    const link = (patch: string): PrGuideUnit => ({
      path: "link",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch,
    });
    const units = {
      "new.ts#1": rename,
      "link#1": link(
        "diff --git a/link b/link\ndeleted file mode 120000\n--- a/link\n+++ /dev/null\n@@ -1 +0,0 @@\n-target\n",
      ),
      "link#2": link(
        "diff --git a/link b/link\nnew file mode 100644\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+text\n",
      ),
    };
    const guide = readyGuide({ units });
    const [section] = guideItems({
      ...guide,
      guide: {
        ...guide.guide,
        sections: [{ title: "T", explanation: "", hunks: ["new.ts#1", "link#1", "link#2"] }],
        other: [],
      },
    });
    expect(section?.cards.map((card) => [card.path, card.oldPath, card.expandable])).toEqual([
      ["new.ts", "old.ts", true],
      // Each half of a type change lacks a side, though git reports both as modified.
      ["link", undefined, false],
      ["link", undefined, false],
    ]);
  });
});

describe("expandCards", () => {
  const added = (count: number, lines: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i): [string, PrGuideUnit] => [
        `f${i}#1`,
        { path: `f${i}`, status: "added", additions: lines, deletions: 0, patch: "" },
      ]),
    );

  it("expands up to the Changes tab's limits, counting each file once", () => {
    expect(expandCards(UNITS)).toBe(true);
    expect(expandCards(added(EXPAND_MAX_FILES, 1))).toBe(true);
    expect(expandCards(added(EXPAND_MAX_FILES + 1, 1))).toBe(false);
    expect(expandCards(added(1, EXPAND_MAX_LINES))).toBe(true);
    expect(expandCards(added(1, EXPAND_MAX_LINES + 1))).toBe(false);
    // Two hunks of one file carry the file's totals once.
    const half = Math.ceil(EXPAND_MAX_LINES / 2) + 1;
    const unit: PrGuideUnit = {
      path: "f",
      status: "added",
      additions: half,
      deletions: 0,
      patch: "",
    };
    expect(expandCards({ "f#1": unit, "f#2": unit })).toBe(true);
  });
});

describe("currentItem", () => {
  it("is the last item whose top reached the bar, else the first", () => {
    expect(currentItem([100, 400, 900], 36, false)).toBe(0);
    expect(currentItem([-50, 36, 500], 36, false)).toBe(1);
    expect(currentItem([-900, -400, 10], 36, false)).toBe(2);
  });

  it("is the last item at the end of the scroll", () => {
    expect(currentItem([-900, 200, 400], 36, true)).toBe(2);
    expect(currentItem([], 36, true)).toBe(0);
  });
});
