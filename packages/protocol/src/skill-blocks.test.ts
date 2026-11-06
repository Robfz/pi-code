import { describe, expect, it } from "vitest";
import { skillCommand, splitSkillBlock } from "./skill-blocks.ts";

const CONTENT = "References are relative to /s.\n\n# Review\nSteps";
const BLOCK = `<skill name="review" location="/s/SKILL.md">\n${CONTENT}\n</skill>`;
const SKILL = { name: "review", location: "/s/SKILL.md", content: CONTENT };

describe("splitSkillBlock", () => {
  it("splits a block without args", () => {
    expect(splitSkillBlock(BLOCK)).toEqual({ skill: SKILL, body: "" });
  });

  it("splits a block from its args", () => {
    expect(splitSkillBlock(`${BLOCK}\n\nCheck the diff\nplease`)).toEqual({
      skill: SKILL,
      body: "Check the diff\nplease",
    });
    const files = '<file name="a.ts" length="1">\na\n</file>\nreview a.ts';
    expect(splitSkillBlock(`${BLOCK}\n\n${files}`)).toEqual({ skill: SKILL, body: files });
  });

  it("keeps a `</skill>` line inside the content", () => {
    const content = "a\n</skill>\nb";
    expect(splitSkillBlock(`<skill name="x" location="/x">\n${content}\n</skill>\n\nargs`)).toEqual(
      { skill: { name: "x", location: "/x", content }, body: "args" },
    );
  });

  it("leaves text without a leading block alone", () => {
    for (const text of [
      "hello",
      "",
      `see\n${BLOCK}`,
      ` ${BLOCK}`,
      `${BLOCK}\nargs`,
      '<skill name="x" location="/x">\nunclosed',
      '<skill name="" location="/x">\nc\n</skill>',
    ]) {
      expect(splitSkillBlock(text)).toEqual({ body: text });
    }
  });
});

describe("skillCommand", () => {
  it("rebuilds the typed command", () => {
    expect(skillCommand("review", "")).toBe("/skill:review");
    expect(skillCommand("review", "  check it\n")).toBe("/skill:review check it");
  });
});
