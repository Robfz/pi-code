import { describe, expect, it } from "vitest";
import { formatFileBlock, splitFileBlocks } from "./file-blocks.ts";

describe("formatFileBlock", () => {
  it("follows pi's CLI convention, plus the content length", () => {
    expect(formatFileBlock({ name: "a.ts", text: "x\ny" })).toBe(
      '<file name="a.ts" length="3">\nx\ny\n</file>\n',
    );
  });

  it("escapes the name", () => {
    expect(formatFileBlock({ name: 'a&"<\n', text: "" })).toBe(
      '<file name="a&amp;&quot;&lt;&#10;" length="0">\n\n</file>\n',
    );
  });
});

describe("splitFileBlocks", () => {
  it("round-trips formatted blocks followed by the typed text", () => {
    const files = [
      { name: "a.ts", text: "const a = 1;\n" },
      { name: "/abs/notes.md", text: "" },
      { name: 'odd ">name &amp;\n', text: '<file name="inner">\nnot a block' },
      { name: "a.xml", text: "1\n</file>\n2" },
    ];
    const message = `${files.map(formatFileBlock).join("")}explain these`;
    expect(splitFileBlocks(message)).toEqual({ files, body: "explain these" });
  });

  it("accepts a last block without a trailing newline", () => {
    expect(splitFileBlocks('<file name="a">\nx\n</file>')).toEqual({
      files: [{ name: "a", text: "x" }],
      body: "",
    });
  });

  it("leaves text without leading blocks alone", () => {
    expect(splitFileBlocks("hello")).toEqual({ files: [], body: "hello" });
    const later = 'see:\n<file name="a">\nx\n</file>\n';
    expect(splitFileBlocks(later)).toEqual({ files: [], body: later });
    const unclosed = '<file name="a">\nx\n';
    expect(splitFileBlocks(unclosed)).toEqual({ files: [], body: unclosed });
    expect(splitFileBlocks('<file name="a">\nx\n</file>trailing')).toEqual({
      files: [],
      body: '<file name="a">\nx\n</file>trailing',
    });
  });

  it("ends a block without a matching length at the first `</file>` line", () => {
    const message = '<file name="a.xml">\n1\n</file>\n2\n</file>\n';
    expect(splitFileBlocks(message)).toEqual({
      files: [{ name: "a.xml", text: "1" }],
      body: "2\n</file>\n",
    });
    expect(splitFileBlocks(message.replace(">\n", ' length="99">\n'))).toEqual({
      files: [{ name: "a.xml", text: "1" }],
      body: "2\n</file>\n",
    });
  });
});
