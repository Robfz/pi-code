import {
  formatFileBlock,
  formatPrBlock,
  formatPrGuideBlock,
  type SessionEntry,
} from "@pi-code/protocol";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { useDrafts } from "@/store/drafts";
import { promptHistory } from "@/store/selectors";
import { hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import { Composer } from "./composer";

const box = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
const caret = () => [box().selectionStart, box().selectionEnd];

let nextId = 0;
const entry = (message: Record<string, unknown>) => {
  const id = `e${nextId++}`;
  return { id, timestamp: new Date(0).toISOString(), type: "message", message } as SessionEntry;
};
const user = (content: unknown) => entry({ role: "user", content, timestamp: 0 });
const reply = (text: string) =>
  entry({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }], timestamp: 0 });
const bash = (command: string, excludeFromContext?: boolean) =>
  entry({
    role: "bashExecution",
    command,
    output: "",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 0,
    ...(excludeFromContext ? { excludeFromContext } : {}),
  });

/** Links `entries` into one branch. */
function chain(entries: SessionEntry[]): SessionEntry[] {
  return entries.map((e, i) => ({ ...e, parentId: entries[i - 1]?.id ?? null }) as SessionEntry);
}

async function setup(entries: SessionEntry[], ui = <Composer />) {
  stubFetch();
  const linked = chain(entries);
  await renderWithStore(
    ui,
    hydratedStore({ transcript: { entries: linked, leafId: linked.at(-1)?.id ?? null } }),
  );
  return userEvent.setup();
}

const THREE = [user("first"), reply("one"), user("second"), reply("two"), user("third")];

describe("promptHistory", () => {
  it("lists prompts and bash commands newest first", () => {
    const history = promptHistory(
      chain([
        user(`${formatFileBlock({ name: "a.ts", text: "x" })}review this\n`),
        reply("ok"),
        bash("ls"),
        bash("pwd", true),
        user([
          { type: "text", text: "part one" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "text", text: "part two" },
        ]),
      ]),
    );
    expect(history).toEqual(["part one\npart two", "!!pwd", "!ls", "review this"]);
  });

  it("skips blank prompts and collapses consecutive duplicates", () => {
    const history = promptHistory(
      chain([
        user("again"),
        user("once"),
        user("again"),
        user([{ type: "image", data: "AAAA", mimeType: "image/png" }]),
        user("  again \n"),
        user(formatFileBlock({ name: "a.ts", text: "x" })),
      ]),
    );
    expect(history).toEqual(["again", "once", "again"]);
  });

  it("skips PR review's prompts, which the user didn't type", () => {
    const block = formatPrBlock({
      number: 12,
      title: "t",
      state: "open",
      url: "u",
      update: false,
      text: "context",
    });
    const guide = formatPrGuideBlock({ number: 12, title: "t", url: "u", text: "guide" });
    expect(
      promptHistory(
        chain([user("mine"), user(`${block}Give me an overview`), user(`${guide}Use it as a map`)]),
      ),
    ).toEqual(["mine"]);
  });

  it("recalls an expanded skill as its command, without attached files", () => {
    const skill = '<skill name="review" location="/s/SKILL.md">\nSteps\n</skill>';
    const file = formatFileBlock({ name: "a.ts", text: "x" });
    expect(promptHistory(chain([user(skill), user(`${skill}\n\n${file}check a.ts`)]))).toEqual([
      "/skill:review check a.ts",
      "/skill:review",
    ]);
  });
});

describe("Composer prompt history", () => {
  it("walks back with ArrowUp and returns to the draft with ArrowDown", async () => {
    const u = await setup(THREE);
    await u.type(box(), "my draft");
    await u.keyboard("{Home}{ArrowUp}");
    expect(box()).toHaveValue("third");
    expect(caret()).toEqual([0, 0]);
    await u.keyboard("{ArrowUp}{ArrowUp}");
    expect(box()).toHaveValue("first");
    await u.keyboard("{ArrowUp}");
    expect(box()).toHaveValue("first");

    // ArrowDown steps only from the end of the text.
    await u.keyboard("{ArrowDown}");
    expect(box()).toHaveValue("first");
    await u.keyboard("{End}{ArrowDown}");
    expect(box()).toHaveValue("second");
    expect(caret()).toEqual([6, 6]);
    await u.keyboard("{ArrowDown}");
    expect(box()).toHaveValue("third");
    await u.keyboard("{ArrowDown}");
    expect(box()).toHaveValue("my draft");
    expect(caret()).toEqual([0, 0]);
    expect(useDrafts.getState().drafts.a1?.browse).toBeUndefined();

    // Not browsing: ArrowDown is native.
    await u.keyboard("{End}{ArrowDown}");
    expect(box()).toHaveValue("my draft");
  });

  it("drops edits to a recalled prompt on the next step", async () => {
    const u = await setup(THREE);
    await u.click(box());
    await u.keyboard("{ArrowUp}");
    await u.keyboard("{End} edited");
    expect(box()).toHaveValue("third edited");
    await u.keyboard("{Home}{ArrowUp}{End}{ArrowDown}");
    expect(box()).toHaveValue("third");
    await u.keyboard("{ArrowDown}");
    expect(box()).toHaveValue("");
  });

  it("steps only from offset 0 with a collapsed selection, and not with modifiers", async () => {
    const u = await setup(THREE);
    await u.type(box(), "hello");
    await u.keyboard("{ArrowUp}");
    expect(box()).toHaveValue("hello");
    await u.keyboard("{ArrowLeft>3/}{ArrowUp}");
    expect(box()).toHaveValue("hello");
    box().setSelectionRange(0, 2);
    await u.keyboard("{ArrowUp}");
    expect(box()).toHaveValue("hello");
    await u.keyboard("{Home}{Shift>}{ArrowUp}{/Shift}{Alt>}{ArrowUp}{/Alt}");
    expect(box()).toHaveValue("hello");
    await u.keyboard("{ArrowUp}");
    expect(box()).toHaveValue("third");
  });

  it("leaves ArrowUp and ArrowDown to the slash menu while it is open", async () => {
    const u = await setup(THREE);
    await u.type(box(), "/");
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    await u.keyboard("{Home}{ArrowUp}");
    expect(box()).toHaveValue("/");
    expect(within(menu).getAllByRole("option").at(-1)).toHaveAttribute("aria-selected", "true");
  });

  it("recalls bash commands and prompts without their attached files", async () => {
    const u = await setup([
      user(`${formatFileBlock({ name: "a.ts", text: "const a = 1;" })}review this`),
      bash("ls"),
      bash("pwd", true),
      bash("pwd", true),
    ]);
    await u.click(box());
    await u.keyboard("{ArrowUp}");
    expect(box()).toHaveValue("!!pwd");
    await u.keyboard("{ArrowUp}");
    expect(box()).toHaveValue("!ls");
    await u.keyboard("{ArrowUp}");
    expect(box()).toHaveValue("review this");
  });

  it("keeps the stashed draft across a remount and ends browsing on send", async () => {
    function Toggle() {
      const [shown, setShown] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShown(!shown)}>
            Toggle composer
          </button>
          {shown && <Composer />}
        </>
      );
    }
    const u = await setup(THREE, <Toggle />);
    await u.type(box(), "keep me");
    await u.keyboard("{Home}{ArrowUp}{ArrowUp}");
    await u.click(screen.getByRole("button", { name: "Toggle composer" }));
    await u.click(screen.getByRole("button", { name: "Toggle composer" }));
    expect(box()).toHaveValue("second");
    await u.click(box());
    await u.keyboard("{End}{ArrowDown}{ArrowDown}");
    expect(box()).toHaveValue("keep me");

    await u.keyboard("{Home}{ArrowUp}{Enter}");
    expect(box()).toHaveValue("");
    expect(useDrafts.getState().drafts.a1?.browse).toBeUndefined();
  });
});
