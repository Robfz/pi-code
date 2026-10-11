import { describe, expect, it } from "vitest";
import { compareRecency, recencyOf } from "./recency.ts";

describe("recencyOf", () => {
  it("takes the last prompt, else the creation", () => {
    expect(
      recencyOf({
        lastPromptAt: "2026-01-02T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({ prompted: true, at: Date.parse("2026-01-02T00:00:00.000Z") });
    expect(recencyOf({ createdAt: "2026-01-01T00:00:00.000Z" })).toEqual({
      prompted: false,
      at: Date.parse("2026-01-01T00:00:00.000Z"),
    });
  });

  it("reads an unparsable time as 0", () => {
    expect(recencyOf({ lastPromptAt: "nope", createdAt: "" })).toEqual({ prompted: true, at: 0 });
  });
});

describe("compareRecency", () => {
  it("puts prompted items first, then the newest", () => {
    const items = [
      { id: "old-created", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "bad", lastPromptAt: "nope", createdAt: "2026-01-09T00:00:00.000Z" },
      { id: "new-created", createdAt: "2026-01-05T00:00:00.000Z" },
      { id: "prompted", lastPromptAt: "2026-01-03T00:00:00.000Z", createdAt: "" },
    ];
    expect(
      items.sort((a, b) => compareRecency(recencyOf(a), recencyOf(b))).map((item) => item.id),
    ).toEqual(["prompted", "bad", "new-created", "old-created"]);
  });
});
