import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT, useDrafts } from "./drafts";

const draft = (agentId = "a1") => useDrafts.getState().drafts[agentId] ?? EMPTY_DRAFT;

/** A draft with `text` and the selection at `start`–`end` (a caret when `end` is omitted). */
function typed(text: string, start = text.length, end = start) {
  useDrafts.getState().edit("a1", text, { start, end });
}

function insert(ref = "@a.ts:3") {
  useDrafts.getState().insertReference("a1", ref);
  return draft();
}

describe("insertReference", () => {
  it.each([
    ["into an empty draft", "", 0, 0, "@a.ts:3 ", 8],
    ["at the start, before text", "fix this", 0, 0, "@a.ts:3 fix this", 8],
    ["at the start, before a space", " fix", 0, 0, "@a.ts:3 fix", 7],
    ["mid-word", "foobar", 3, 3, "foo @a.ts:3 bar", 12],
    ["after a space, at the end", "see ", 4, 4, "see @a.ts:3 ", 12],
    ["after a word, at the end", "see", 3, 3, "see @a.ts:3 ", 12],
    ["after a space, before text", "see here", 4, 4, "see @a.ts:3 here", 12],
    ["after a newline", "see\nhere", 4, 4, "see\n@a.ts:3 here", 12],
    ["replacing a selection", "look at this one", 8, 12, "look at @a.ts:3 one", 15],
    ["replacing a whole word without spaces", "a-b-c", 1, 4, "a @a.ts:3 c", 10],
  ])("%s", (_name, text, start, end, expected, caret) => {
    typed(text, start, end);
    const result = insert();
    expect(result.text).toBe(expected);
    expect(result.selection).toEqual({ start: caret, end: caret });
  });

  it("bumps external and keeps attachments", () => {
    const attachments = [{ key: "k", name: "a.txt", kind: "text" as const, text: "x" }];
    useDrafts.getState().setAttachments("a1", attachments);
    typed("hi");
    const before = draft().external;
    expect(insert().external).toBe(before + 1);
    expect(draft().attachments).toBe(attachments);
  });

  it("chains at the caret it leaves", () => {
    typed("");
    insert("@a.ts:1");
    expect(insert("@b.ts:2").text).toBe("@a.ts:1 @b.ts:2 ");
  });
});

describe("drafts", () => {
  it("keeps one draft per conversation", () => {
    useDrafts.getState().edit("a1", "one", { start: 3, end: 3 });
    useDrafts.getState().edit("a2", "two", { start: 1, end: 2 });
    expect(draft("a1")).toMatchObject({ text: "one", selection: { start: 3, end: 3 } });
    expect(draft("a2")).toMatchObject({ text: "two", selection: { start: 1, end: 2 } });
  });

  it("edit leaves the store untouched when text and selection are unchanged", () => {
    typed("hi", 1, 2);
    const before = useDrafts.getState();
    typed("hi", 1, 2);
    expect(useDrafts.getState()).toBe(before);
    typed("hi", 2);
    expect(draft().selection).toEqual({ start: 2, end: 2 });
  });

  it("replace puts the caret at the end and bumps external", () => {
    typed("old", 1);
    useDrafts.getState().replace("a1", "new text");
    expect(draft()).toMatchObject({
      text: "new text",
      selection: { start: 8, end: 8 },
      external: 1,
    });
  });

  it("clear empties text and attachments without bumping external", () => {
    useDrafts.getState().replace("a1", "hello");
    useDrafts
      .getState()
      .setAttachments("a1", [{ key: "k", name: "a.txt", kind: "text", text: "x" }]);
    useDrafts.getState().clear("a1");
    expect(draft()).toEqual({ ...EMPTY_DRAFT, external: 1 });
  });
});
