import { describe, expect, it } from "vitest";
import { draftPrPrompt } from "./pr";

describe("draftPrPrompt", () => {
  it("quotes the branch for the shell", () => {
    expect(draftPrPrompt("x;curl$(id)|sh")).toContain("`git push -u origin 'x;curl$(id)|sh'`");
    expect(draftPrPrompt("it's")).toContain("`git push -u origin 'it'\\''s'`");
  });

  it("pushes HEAD when detached", () => {
    expect(draftPrPrompt(null)).toContain("`git push -u origin HEAD`");
  });
});
