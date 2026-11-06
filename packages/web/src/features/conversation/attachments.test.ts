import { formatFileBlock } from "@pi-code/protocol";
import { describe, expect, it } from "vitest";
import { composePromptMessage } from "./attachments";

const FILES =
  formatFileBlock({ name: "a.ts", text: "const a = 1;" }) +
  formatFileBlock({ name: "b.md", text: "# B" });

describe("composePromptMessage", () => {
  it("puts file blocks ahead of the typed text", () => {
    expect(composePromptMessage("review these", FILES)).toBe(`${FILES}review these`);
    expect(composePromptMessage("", FILES)).toBe(FILES);
    expect(composePromptMessage("/review now", FILES)).toBe(`${FILES}/review now`);
    expect(composePromptMessage("hello", "")).toBe("hello");
  });

  it("keeps a skill command first, then the files, then the args", () => {
    expect(composePromptMessage("/skill:review check a.ts", FILES)).toBe(
      `/skill:review ${FILES}check a.ts`,
    );
    expect(composePromptMessage("/skill:review", FILES)).toBe(`/skill:review ${FILES}`);
  });

  it("ends the skill name at a space even when a newline follows it", () => {
    expect(composePromptMessage("/skill:review\ncheck a.ts", FILES)).toBe(
      `/skill:review ${FILES}check a.ts`,
    );
    expect(composePromptMessage("/skill:review\n\ncheck\nthis", "")).toBe(
      "/skill:review check\nthis",
    );
    expect(composePromptMessage("/skill:review", "")).toBe("/skill:review");
  });
});
