import { describe, expect, it } from "vitest";
import { formatFileBlock } from "./file-blocks.ts";
import { formatPrBlock } from "./pr-blocks.ts";
import { formatPrGuideBlock } from "./pr-guide-blocks.ts";
import { splitUserMessage } from "./user-message.ts";

const SKILL = {
  name: "review",
  location: "/s/SKILL.md",
  content: "References are relative to /s.",
};
const skillBlock = (args: string) =>
  `<skill name="review" location="/s/SKILL.md">\n${SKILL.content}\n</skill>\n\n${args}`;
const FILE = { name: "a.ts", text: "const a = 1;" };
const PR = {
  number: 12,
  title: "Speed up",
  state: "open" as const,
  url: "https://github.com/o/r/pull/12",
  update: false,
  text: "Pull request o/r#12",
};
const GUIDE = { number: 12, title: "Speed up", url: PR.url, text: "Review guide for o/r#12" };

describe("splitUserMessage", () => {
  it("splits a skill, files, PRs and guides from the text, in that order", () => {
    const text = skillBlock(
      `${formatFileBlock(FILE)}${formatPrBlock(PR)}${formatPrGuideBlock(GUIDE)}Read it`,
    );
    expect(splitUserMessage(text)).toEqual({
      skill: SKILL,
      files: [FILE],
      prs: [PR],
      guides: [GUIDE],
      body: "Read it",
    });
  });

  it("splits each block alone", () => {
    expect(splitUserMessage(`${formatPrGuideBlock(GUIDE)}Read it`)).toEqual({
      files: [],
      prs: [],
      guides: [GUIDE],
      body: "Read it",
    });
    expect(splitUserMessage(skillBlock("args"))).toEqual({
      skill: SKILL,
      files: [],
      prs: [],
      guides: [],
      body: "args",
    });
  });

  it("leaves blocks out of order in the text", () => {
    const text = `${formatPrGuideBlock(GUIDE)}${formatPrBlock(PR)}hi`;
    expect(splitUserMessage(text)).toEqual({
      files: [],
      prs: [],
      guides: [GUIDE],
      body: `${formatPrBlock(PR)}hi`,
    });
    expect(splitUserMessage("hello")).toEqual({ files: [], prs: [], guides: [], body: "hello" });
  });
});
