import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDrafts } from "@/store/drafts";
import { hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import { Composer } from "./composer";
import { ComposerInput } from "./composer-input";

const box = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
const mirror = () => screen.getByTestId("composer-mirror");
const blue = () => [...mirror().querySelectorAll("span")].map((span) => span.textContent);

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A controlled `ComposerInput` starting at `initial`. */
function Input({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <ComposerInput aria-label="Message" value={value} onValueChange={setValue} />;
}

const renderInput = (initial?: string) => render(<Input initial={initial} />);

/** Places the selection without editing. */
async function select(start: number, end = start) {
  const user = userEvent.setup();
  await user.click(box());
  act(() => box().setSelectionRange(start, end));
  return user;
}

describe("ComposerInput mirror", () => {
  it("shows references as blue spans", () => {
    renderInput('see @a.ts:3, @"my dir/b.ts":4-5 and @abc1234:./c.ts:2 but not @scope/pkg');
    expect(blue()).toEqual(["@a.ts:3", '@"my dir/b.ts":4-5', "@abc1234:./c.ts:2"]);
  });

  it("keeps the mirror text equal to the value after each edit", async () => {
    renderInput();
    const user = userEvent.setup();
    await user.click(box());
    for (const key of ["l", " ", "@", "a", ".", "t", "s", ":", "3", "{Enter}", "{Backspace}"]) {
      await user.keyboard(key);
      expect(mirror().textContent).toBe(`${box().value}\u200b`);
    }
    await user.keyboard("{Backspace}");
    expect(box()).toHaveValue("l ");
    expect(mirror().textContent).toBe("l \u200b");
  });

  it("copies the textarea's scroll position", () => {
    renderInput("a\nb\nc");
    box().scrollTop = 30;
    fireEvent.scroll(box());
    expect(mirror().scrollTop).toBe(30);
  });
});

describe("ComposerInput whole-reference delete", () => {
  it("Backspace at the end of a reference removes it", async () => {
    renderInput();
    const user = userEvent.setup();
    await user.type(box(), "see @a.ts:3{Backspace}");
    expect(box()).toHaveValue("see ");
    expect(box().selectionStart).toBe(4);
  });

  it("a deletion inside a reference removes it with the caret at its start", async () => {
    renderInput("x @src/a.ts:3 y");
    const user = await select(7);
    await user.keyboard("{Backspace}");
    expect(box()).toHaveValue("x  y");
    expect(box().selectionStart).toBe(2);
    expect(box().selectionEnd).toBe(2);

    act(() => box().setSelectionRange(0, 4));
    await user.keyboard("{Backspace}");
    expect(box()).toHaveValue("");
  });

  it("Delete inside a reference removes it", async () => {
    renderInput("x @a.ts:3 y");
    const user = await select(4);
    await user.keyboard("{Delete}");
    expect(box()).toHaveValue("x  y");
    expect(box().selectionStart).toBe(2);
  });

  it("a cut overlapping a reference removes it whole", async () => {
    renderInput("x @a.ts:3 y");
    const user = await select(0, 5);
    await user.cut();
    expect(box()).toHaveValue(" y");
    expect(box().selectionStart).toBe(0);
  });

  it("a deletion covering a reference and more removes exactly that range", async () => {
    renderInput("x @a.ts:3 y");
    const user = await select(1, 10);
    await user.keyboard("{Backspace}");
    expect(box()).toHaveValue("xy");
    expect(box().selectionStart).toBe(1);
  });

  it("typing inside a reference edits it and drops the highlight", async () => {
    renderInput("x @a.ts:3 y");
    const user = await select(8);
    await user.keyboard("q");
    expect(box()).toHaveValue("x @a.ts:q3 y");
    expect(blue()).toEqual([]);
  });

  it("deleting a selected `@ ` before a reference leaves the reference intact", async () => {
    renderInput("x @ @a.ts:3");
    const user = await select(2, 4);
    await user.keyboard("{Backspace}");
    expect(box()).toHaveValue("x @a.ts:3");
    expect(blue()).toEqual(["@a.ts:3"]);
  });

  it("waits for compositionend before removing a reference", () => {
    renderInput("x @a.ts:3");
    const el = box();
    act(() => el.setSelectionRange(9, 9));
    fireEvent.compositionStart(el);
    fireEvent.input(el, { target: { value: "x @a.ts:" }, isComposing: true });
    expect(el).toHaveValue("x @a.ts:");

    fireEvent.compositionEnd(el);
    expect(el).toHaveValue("x ");
    expect(el.selectionStart).toBe(2);
  });

  it("leaves a composition that inserts text alone", () => {
    renderInput("x @a.ts:3");
    const el = box();
    act(() => el.setSelectionRange(9, 9));
    fireEvent.compositionStart(el);
    fireEvent.input(el, { target: { value: "x @a.ts:34" }, isComposing: true });
    fireEvent.compositionEnd(el);
    expect(el).toHaveValue("x @a.ts:34");
  });
});

describe("Composer with ComposerInput", () => {
  it("writes the rewritten text to the draft", async () => {
    stubFetch();
    await renderWithStore(<Composer />, hydratedStore());
    const user = userEvent.setup();
    await user.type(box(), "look at @a.ts:3");
    expect(blue()).toEqual(["@a.ts:3"]);
    await user.keyboard("{Backspace}");
    expect(useDrafts.getState().drafts.a1).toMatchObject({
      text: "look at ",
      selection: { start: 8, end: 8 },
    });
  });
});
