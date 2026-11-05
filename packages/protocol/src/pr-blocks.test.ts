import { describe, expect, it } from "vitest";
import { formatPrBlock, type PrBlock, prBlockLabel, splitPrBlocks } from "./pr-blocks.ts";

const BLOCK: PrBlock = {
  number: 12,
  title: 'Fix "quotes" & <tags>',
  state: "open",
  url: "https://github.com/o/r/pull/12",
  update: false,
  text: "Pull request o/r#12\nBase: main",
};

describe("formatPrBlock", () => {
  it("writes the attributes escaped, then the content and its length", () => {
    expect(formatPrBlock(BLOCK)).toBe(
      '<pr number="12" state="open" title="Fix &quot;quotes&quot; &amp; &lt;tags>" url="https://github.com/o/r/pull/12" length="30">\nPull request o/r#12\nBase: main\n</pr>\n',
    );
    expect(formatPrBlock({ ...BLOCK, update: true, text: "" })).toContain(
      ' update="true" length="0">',
    );
  });
});

describe("splitPrBlocks", () => {
  it("round-trips a block followed by the request", () => {
    const update = { ...BLOCK, state: "merged" as const, update: true, text: "a\n</pr>\nb" };
    expect(splitPrBlocks(`${formatPrBlock(BLOCK)}${formatPrBlock(update)}Look at it`)).toEqual({
      prs: [BLOCK, update],
      body: "Look at it",
    });
  });

  it("leaves text without a leading block alone", () => {
    expect(splitPrBlocks("hello")).toEqual({ prs: [], body: "hello" });
    const later = `see\n${formatPrBlock(BLOCK)}`;
    expect(splitPrBlocks(later)).toEqual({ prs: [], body: later });
    const unclosed = '<pr number="1" state="open" title="t" url="u" length="1">\nx';
    expect(splitPrBlocks(unclosed)).toEqual({ prs: [], body: unclosed });
    const badState = formatPrBlock(BLOCK).replace('state="open"', 'state="draft"');
    expect(splitPrBlocks(badState)).toEqual({ prs: [], body: badState });
  });

  it("ends a block whose length doesn't check out at the first `</pr>` line", () => {
    const message = '<pr number="1" state="closed" title="t" url="u" length="99">\nx\n</pr>\nask';
    expect(splitPrBlocks(message)).toEqual({
      prs: [{ number: 1, state: "closed", title: "t", url: "u", update: false, text: "x" }],
      body: "ask",
    });
  });
});

describe("prBlockLabel", () => {
  it("names the PR, marking updates", () => {
    expect(prBlockLabel(BLOCK)).toBe('#12 Fix "quotes" & <tags>');
    expect(prBlockLabel({ ...BLOCK, update: true })).toBe('#12 Fix "quotes" & <tags> (updated)');
  });
});
