import { describe, expect, it } from "vitest";
import { guideFileId, guideHunkId } from "./pr-guide.ts";

describe("guide ids", () => {
  it("names hunks by path and 1-based index, files by index 0", () => {
    expect(guideHunkId("src/a.ts", 2)).toBe("src/a.ts#2");
    expect(guideFileId("img/logo.png")).toBe("img/logo.png#0");
  });

  it("keeps ids on one line", () => {
    expect(guideHunkId("a\nb\u2028c", 1)).toBe("a\\u000ab\\u2028c#1");
  });
});
