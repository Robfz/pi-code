import { describe, expect, it } from "vitest";
import { splitUrls } from "@/components/linkified-text";
import { stripAnsi } from "./ansi";
import { baseName, contentText, toolResultText } from "./content";

describe("stripAnsi", () => {
  it("removes color, OSC and lone escapes", () => {
    expect(stripAnsi("\u001b[38;2;138;190;183m🔌 MCP: 2 servers enabled\u001b[39m")).toBe(
      "🔌 MCP: 2 servers enabled",
    );
    expect(stripAnsi("\u001b]8;;https://x.dev\u0007link\u001b]8;;\u0007")).toBe("link");
    expect(stripAnsi("a\u001bMb")).toBe("ab");
    expect(stripAnsi("plain")).toBe("plain");
  });
});

describe("splitUrls", () => {
  it("splits URLs out of text and leaves trailing punctuation", () => {
    expect(splitUrls("Open https://a.dev/x?y=1. Then paste.")).toEqual([
      { type: "text", text: "Open " },
      { type: "url", url: "https://a.dev/x?y=1" },
      { type: "text", text: ". Then paste." },
    ]);
    expect(splitUrls("(see https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([
      { type: "text", text: "(see " },
      { type: "url", url: "https://en.wikipedia.org/wiki/Foo_(bar)" },
      { type: "text", text: ")" },
    ]);
    expect(splitUrls("no links")).toEqual([{ type: "text", text: "no links" }]);
  });
});

describe("content helpers", () => {
  it("reads string and array content", () => {
    expect(contentText("hi")).toBe("hi");
    expect(
      contentText([
        { type: "text", text: "a" },
        { type: "image", data: "", mimeType: "image/png" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
    expect(toolResultText({ content: [{ type: "text", text: "out" }] })).toBe("out");
    expect(toolResultText({ content: [] })).toBe("");
    expect(toolResultText(undefined)).toBe("");
    expect(baseName("/home/me/project/")).toBe("project");
    expect(baseName("/")).toBe("/");
  });
});
