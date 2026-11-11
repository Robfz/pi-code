import { describe, expect, it } from "vitest";
import { formatPrBlock } from "./pr-blocks.ts";
import {
  formatPrGuideBlock,
  type PrGuideBlock,
  prGuideBlockLabel,
  splitPrGuideBlocks,
} from "./pr-guide-blocks.ts";

const BLOCK: PrGuideBlock = {
  number: 12,
  title: 'Fix "quotes" & <tags>',
  url: "https://github.com/o/r/pull/12",
  text: "Review guide for o/r#12\n1. Core",
};

describe("formatPrGuideBlock", () => {
  it("writes the attributes escaped, then the content and its length", () => {
    expect(formatPrGuideBlock(BLOCK)).toBe(
      '<pr-guide number="12" title="Fix &quot;quotes&quot; &amp; &lt;tags>" url="https://github.com/o/r/pull/12" length="31">\nReview guide for o/r#12\n1. Core\n</pr-guide>\n',
    );
  });
});

describe("splitPrGuideBlocks", () => {
  it("round-trips blocks followed by the request", () => {
    const tricky = { ...BLOCK, title: "a\nb", text: "x\n</pr-guide>\ny" };
    expect(
      splitPrGuideBlocks(`${formatPrGuideBlock(BLOCK)}${formatPrGuideBlock(tricky)}Read it`),
    ).toEqual({ guides: [BLOCK, tricky], body: "Read it" });
  });

  it("leaves text without a leading block alone", () => {
    expect(splitPrGuideBlocks("hello")).toEqual({ guides: [], body: "hello" });
    const later = `see\n${formatPrGuideBlock(BLOCK)}`;
    expect(splitPrGuideBlocks(later)).toEqual({ guides: [], body: later });
    const unclosed = '<pr-guide number="1" title="t" url="u" length="1">\nx';
    expect(splitPrGuideBlocks(unclosed)).toEqual({ guides: [], body: unclosed });
    const pr = formatPrBlock({ ...BLOCK, state: "open", update: false });
    expect(splitPrGuideBlocks(pr)).toEqual({ guides: [], body: pr });
  });

  it("ends a block whose length doesn't check out at the first `</pr-guide>` line", () => {
    const message = '<pr-guide number="1" title="t" url="u" length="99">\nx\n</pr-guide>\nask';
    expect(splitPrGuideBlocks(message)).toEqual({
      guides: [{ number: 1, title: "t", url: "u", text: "x" }],
      body: "ask",
    });
  });
});

describe("prGuideBlockLabel", () => {
  it("names the PR and marks the guide", () => {
    expect(prGuideBlockLabel(BLOCK)).toBe('#12 Fix "quotes" & <tags> (guide)');
  });
});
