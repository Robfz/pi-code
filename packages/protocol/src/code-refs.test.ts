import { describe, expect, it } from "vitest";
import { type CodeRef, findCodeRefs, formatCodeRef } from "./code-refs.ts";

/** The references in `text`, as `[matched text, ref]` pairs. */
const found = (text: string) =>
  findCodeRefs(text).map(({ index, length, ...ref }) => [text.slice(index, index + length), ref]);

describe("findCodeRefs", () => {
  it.each<[string, string, CodeRef]>([
    ["one line", "@src/app.ts:42", { path: "src/app.ts", start: 42, end: 42 }],
    ["a range", "@src/app.ts:40-45", { path: "src/app.ts", start: 40, end: 45 }],
    ["a quoted path", '@"my dir/a.ts":40-45', { path: "my dir/a.ts", start: 40, end: 45 }],
    [
      "a rev",
      "@3f2a9c1:./src/app.ts:40-45",
      { path: "src/app.ts", start: 40, end: 45, rev: "3f2a9c1" },
    ],
    [
      "a rev without ./",
      "@abc1234:src/a.ts:4",
      { path: "src/a.ts", start: 4, end: 4, rev: "abc1234" },
    ],
    [
      "a rev before ../",
      "@abc1234:../x.ts:4",
      { path: "../x.ts", start: 4, end: 4, rev: "abc1234" },
    ],
    [
      "a full sha",
      `@${"a".repeat(40)}:a.ts:1`,
      { path: "a.ts", start: 1, end: 1, rev: "a".repeat(40) },
    ],
    [
      "a rev and a quoted path",
      '@abc1234:"./my dir/a.ts":2',
      { path: "my dir/a.ts", start: 2, end: 2, rev: "abc1234" },
    ],
    ["a hex name without a path", "@abc1234:4", { path: "abc1234", start: 4, end: 4 }],
    [
      "41 hex characters",
      `@${"a".repeat(41)}:a.ts:1`,
      { path: `${"a".repeat(41)}:a.ts`, start: 1, end: 1 },
    ],
    ["uppercase hex", "@ABC1234:a.ts:1", { path: "ABC1234:a.ts", start: 1, end: 1 }],
    ["a moving ref", "@HEAD:a.ts:3", { path: "HEAD:a.ts", start: 3, end: 3 }],
    ["a colon in a bare path", "@a:b.ts:4", { path: "a:b.ts", start: 4, end: 4 }],
    ["an absolute path", "@/home/me/a.ts:7", { path: "/home/me/a.ts", start: 7, end: 7 }],
    [
      "a scoped package path",
      "@scope/pkg/index.ts:1",
      { path: "scope/pkg/index.ts", start: 1, end: 1 },
    ],
  ])("reads %s", (_, text, ref) => {
    expect(found(text)).toEqual([[text, ref]]);
  });

  it("stops a bare path at the first line spec that ends a reference (line:column)", () => {
    expect(found("@src/a.ts:12:5")).toEqual([
      ["@src/a.ts:12", { path: "src/a.ts", start: 12, end: 12 }],
    ]);
  });

  it.each([
    ["a package", "@scope/pkg"],
    ["a mention", "@someone"],
    ["no line", "@a.ts"],
    ["an email-like word", "a@b.c:25"],
    ["a parenthesis before", "(@a.ts:3)"],
    ["a bare path", "src/a.ts:3"],
    ["an open range", "@a.ts:12-"],
    ["a backwards range", "@a.ts:5-3"],
    ["an empty range", "@a.ts:5-5"],
    ["line zero", "@a.ts:0"],
    ["a leading zero", "@a.ts:05"],
    ["a leading zero in the end", "@a.ts:1-05"],
    ["a letter after the line", "@a.ts:3x"],
    ["a dash after the line", "@a.ts:3-x"],
    ["an empty path", "@:3"],
    ["an empty quoted path", '@"":3'],
    ["an unclosed quote", '@"a.ts:3'],
    ["a line break in quotes", '@"a\nb.ts":3'],
    ["no line after quotes", '@"a b.ts" :3'],
    ["a backtick in a bare path", "@a`b.ts:3"],
    ["a quote in a bare path", '@a"b.ts:3'],
    ["whitespace before the line", "@a.ts :3"],
  ])("ignores %s", (_, text) => {
    expect(findCodeRefs(text)).toEqual([]);
  });

  it.each([
    ["the text start", "@a.ts:3 x"],
    ["a space", "see @a.ts:3"],
    ["a tab", "see\t@a.ts:3"],
    ["a line break", "see\n@a.ts:3"],
    ["a backtick", "see `@a.ts:3`"],
  ])("starts at %s", (_, text) => {
    expect(found(text)).toEqual([["@a.ts:3", { path: "a.ts", start: 3, end: 3 }]]);
  });

  it.each([..."`.,;:!?)]}'\"", " ", "\n"])("ends before %j", (char) => {
    expect(found(`@a.ts:3${char}x`)).toEqual([["@a.ts:3", { path: "a.ts", start: 3, end: 3 }]]);
    expect(found(`@a.ts:3-4${char}`)).toEqual([["@a.ts:3-4", { path: "a.ts", start: 3, end: 4 }]]);
  });

  it("reads references in inline code and before punctuation", () => {
    expect(found("Look at `@a.ts:3`, then @b.ts:4-5. Also (see @c.ts:6).")).toEqual([
      ["@a.ts:3", { path: "a.ts", start: 3, end: 3 }],
      ["@b.ts:4-5", { path: "b.ts", start: 4, end: 5 }],
      ["@c.ts:6", { path: "c.ts", start: 6, end: 6 }],
    ]);
  });

  it("finds two references in one line, in order", () => {
    expect(found('@a.ts:1 and @"b c.ts":2-3')).toEqual([
      ["@a.ts:1", { path: "a.ts", start: 1, end: 1 }],
      ['@"b c.ts":2-3', { path: "b c.ts", start: 2, end: 3 }],
    ]);
  });

  it("skips a non-reference and keeps scanning", () => {
    expect(found("@someone @a.ts:2")).toEqual([["@a.ts:2", { path: "a.ts", start: 2, end: 2 }]]);
    expect(found("x@a.ts:1 @b.ts:2")).toEqual([["@b.ts:2", { path: "b.ts", start: 2, end: 2 }]]);
  });

  it("reports UTF-16 offsets after non-ASCII text", () => {
    // "año " is 4 code units and the emoji 2.
    expect(findCodeRefs("año 🎉 @a.ts:3")).toEqual([
      { path: "a.ts", start: 3, end: 3, index: 7, length: 7 },
    ]);
    expect(found("año 🎉 @a.ts:3")).toEqual([["@a.ts:3", { path: "a.ts", start: 3, end: 3 }]]);
  });
});

describe("formatCodeRef", () => {
  it.each<[string, CodeRef, string | null]>([
    ["one line", { path: "src/a.ts", start: 4, end: 4 }, "@src/a.ts:4"],
    ["a range", { path: "src/a.ts", start: 4, end: 9 }, "@src/a.ts:4-9"],
    ["an absolute path", { path: "/abs/a.ts", start: 1, end: 1 }, "@/abs/a.ts:1"],
    ["whitespace", { path: "my dir/a.ts", start: 40, end: 45 }, '@"my dir/a.ts":40-45'],
    ["a rev-like path", { path: "abc1234:a.ts", start: 3, end: 3 }, '@"abc1234:a.ts":3'],
    ["a hex name", { path: "abc1234", start: 3, end: 3 }, "@abc1234:3"],
    ["an inner line spec", { path: "a:3", start: 5, end: 5 }, '@"a:3":5'],
    ["a backtick", { path: "a`b.ts", start: 1, end: 1 }, '@"a`b.ts":1'],
    ["a rev", { path: "src/a.ts", start: 4, end: 4, rev: "abc1234" }, "@abc1234:./src/a.ts:4"],
    [
      "a rev and ./",
      { path: "./src/a.ts", start: 4, end: 4, rev: "abc1234" },
      "@abc1234:./src/a.ts:4",
    ],
    ["a rev and ../", { path: "../x.ts", start: 4, end: 4, rev: "abc1234" }, "@abc1234:../x.ts:4"],
    [
      "a rev and whitespace",
      { path: "a b.ts", start: 1, end: 2, rev: "abc1234" },
      '@abc1234:"./a b.ts":1-2',
    ],
    ["a quote", { path: 'a"b.ts', start: 1, end: 1 }, null],
    ["a line break", { path: "a\nb.ts", start: 1, end: 1 }, null],
    ["a carriage return", { path: "a\rb.ts", start: 1, end: 1 }, null],
    ["an empty path", { path: "", start: 1, end: 1 }, null],
  ])("writes %s", (_, ref, text) => {
    expect(formatCodeRef(ref)).toBe(text);
  });

  it.each<CodeRef>([
    { path: "src/a.ts", start: 4, end: 4 },
    { path: "src/a.ts", start: 4, end: 12 },
    { path: "my dir/a b.ts", start: 1, end: 2 },
    { path: "abc1234:a.ts", start: 3, end: 3 },
    { path: "abc1234", start: 3, end: 3 },
    { path: "a:b.ts", start: 4, end: 4 },
    { path: "a:3", start: 5, end: 5 },
    { path: "a.ts:3-4", start: 5, end: 5 },
    { path: "a`b.ts", start: 1, end: 1 },
    { path: "HEAD:a.ts", start: 3, end: 3 },
    { path: "/abs/a.ts", start: 7, end: 7 },
    { path: "ñandú/🎉.ts", start: 1, end: 1 },
    { path: "src/a.ts", start: 4, end: 4, rev: "abc1234" },
    { path: "../x.ts", start: 4, end: 6, rev: "3f2a9c1" },
    { path: "dir name/a.ts", start: 4, end: 4, rev: "3f2a9c1" },
  ])("round trips %j through findCodeRefs", (ref) => {
    const text = formatCodeRef(ref) as string;
    for (const around of [text, `see ${text}.`, `\`${text}\``]) {
      const index = around.indexOf("@");
      expect(findCodeRefs(around)).toEqual([{ ...ref, index, length: text.length }]);
    }
  });
});
