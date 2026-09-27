import { describe, expect, it } from "vitest";
import { LineSplitter } from "./jsonl.ts";

function collect() {
  const lines: string[] = [];
  const splitter = new LineSplitter((l) => lines.push(l));
  return { lines, splitter };
}

const enc = (s: string) => Buffer.from(s, "utf8");

describe("LineSplitter", () => {
  it("does not split on U+2028 / U+2029 inside JSON strings", () => {
    const { lines, splitter } = collect();
    const rec = JSON.stringify({ text: "a\u2028b\u2029c" });
    expect(rec).toContain("\u2028"); // JSON.stringify leaves them unescaped
    splitter.push(enc(`${rec}\n`));
    expect(lines).toEqual([rec]);
    expect(JSON.parse(lines[0] as string).text).toBe("a\u2028b\u2029c");
  });

  it("strips a trailing CR (CRLF lines)", () => {
    const { lines, splitter } = collect();
    splitter.push(enc('{"a":1}\r\n{"b":2}\r\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("reassembles code points split across chunks", () => {
    const { lines, splitter } = collect();
    const text = '{"t":"é€😀"}\n{"u":"ü"}\n';
    for (const byte of enc(text)) splitter.push(Uint8Array.of(byte));
    expect(lines).toEqual(['{"t":"é€😀"}', '{"u":"ü"}']);
  });

  it("joins lines spread over many chunks and handles several lines per chunk", () => {
    const { lines, splitter } = collect();
    splitter.push(enc('{"a":'));
    splitter.push(enc("1"));
    splitter.push(enc('}\n{"b":2}\n{"c"'));
    splitter.push(enc(":3}\n"));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("emits a final unterminated line on end", () => {
    const { lines, splitter } = collect();
    splitter.push(enc('{"a":1}\n{"b":'));
    splitter.push(enc("2}"));
    expect(lines).toEqual(['{"a":1}']);
    splitter.end();
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("keeps empty lines as empty strings", () => {
    const { lines, splitter } = collect();
    splitter.push(enc("\n\r\nx\n"));
    expect(lines).toEqual(["", "", "x"]);
  });
});
