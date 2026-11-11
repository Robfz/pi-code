import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { stubMatchMedia } from "@/test/dom-stubs";
import { stubUserAgent, USER_AGENTS } from "@/test/user-agents";
import { KeyboardProvider, NOTICE_MS, useCommand } from "./keyboard-provider";
import { APP_QUERY } from "./keymap";

const ran = vi.fn<(command: string) => void>();
const composerKeys = vi.fn();

/** Registers every command but `conversation.previous`. */
function Commands() {
  useCommand("conversation.new", () => ran("new"));
  useCommand("conversation.next", () => ran("next"));
  useCommand("conversation.goTo", (position) => ran(`goTo ${position}`));
  useCommand("sidebar.toggle", () => ran("sidebar"));
  return null;
}

function renderKeyboard(overlay?: ReactNode) {
  render(
    <KeyboardProvider>
      <Commands />
      <textarea aria-label="Composer" onKeyDown={composerKeys} />
      {overlay}
    </KeyboardProvider>,
  );
  if (!overlay) screen.getByRole("textbox", { name: "Composer" }).focus();
}

/** A keydown on the focused element; whether it went through (wasn't `preventDefault`ed). */
const press = (init: KeyboardEventInit & { keyCode?: number }) =>
  fireEvent.keyDown(document.activeElement ?? document.body, init);

const leader = { key: "j", code: "KeyJ", metaKey: true };
const C = { key: "c", code: "KeyC" };
const H = { key: "h", code: "KeyH" };
const cmdB = { key: "b", code: "KeyB", metaKey: true };
const pill = () => screen.queryByRole("status");
const help = () => screen.queryByRole("dialog", { name: "Keyboard shortcuts" });

beforeEach(() => {
  stubUserAgent(USER_AGENTS.macChrome);
  stubMatchMedia(() => false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  ran.mockReset();
  composerKeys.mockReset();
});

describe("the leader", () => {
  it("arms on ⌘J, then runs the next key's command; both are swallowed", () => {
    renderKeyboard();
    expect(press(leader)).toBe(false);
    expect(pill()).toHaveTextContent("⌘J … Esc to cancel");
    expect(press(C)).toBe(false);
    expect(ran).toHaveBeenCalledWith("new");
    expect(pill()).toBeNull();
    expect(composerKeys).not.toHaveBeenCalled();
  });

  it("takes the second key with ⌘ held, so ⌘J ⌘C doesn't copy", () => {
    renderKeyboard();
    press(leader);
    expect(press({ ...C, metaKey: true })).toBe(false);
    expect(ran).toHaveBeenCalledWith("new");
  });

  it("takes digits by code", () => {
    renderKeyboard();
    press(leader);
    press({ key: "&", code: "Digit1" });
    press(leader);
    press({ key: "3", code: "Digit3", metaKey: true });
    expect(ran.mock.calls).toEqual([["goTo 1"], ["goTo 3"]]);
  });

  it("uses Ctrl+J on Windows and Linux", () => {
    stubUserAgent(USER_AGENTS.windowsEdge);
    renderKeyboard();
    expect(press(leader)).toBe(true);
    expect(press({ ...leader, metaKey: false, ctrlKey: true })).toBe(false);
    expect(pill()).toHaveTextContent("Ctrl+J … Esc to cancel");
    press({ ...C, ctrlKey: true });
    expect(ran).toHaveBeenCalledWith("new");
  });

  it("is cancelled by Esc, which goes no further", () => {
    const onOpenChange = vi.fn();
    renderKeyboard(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Some dialog.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    press(leader);
    expect(press({ key: "Escape", code: "Escape" })).toBe(false);
    expect(pill()).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    // Idle again: Esc reaches the dialog.
    press({ key: "Escape", code: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("is cancelled by window blur", () => {
    renderKeyboard();
    press(leader);
    act(() => {
      fireEvent.blur(window);
    });
    expect(pill()).toBeNull();
    expect(press(C)).toBe(true);
    expect(composerKeys).toHaveBeenCalledTimes(1);
    expect(ran).not.toHaveBeenCalled();
  });

  it("swallows an unbound key and says so for 1.5 s", () => {
    vi.useFakeTimers();
    renderKeyboard();
    press(leader);
    expect(press({ key: "x", code: "KeyX" })).toBe(false);
    expect(composerKeys).not.toHaveBeenCalled();
    expect(pill()).toHaveTextContent("⌘J X: not a command");
    act(() => vi.advanceTimersByTime(NOTICE_MS - 1));
    expect(pill()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(pill()).toBeNull();
    expect(press(C)).toBe(true);
  });

  it("keeps a pending leader armed past an earlier notice's timeout", () => {
    vi.useFakeTimers();
    renderKeyboard();
    press(leader);
    press({ key: "x", code: "KeyX" });
    expect(pill()).toHaveTextContent("⌘J X: not a command");
    act(() => vi.advanceTimersByTime(NOTICE_MS / 2));
    press(leader);
    act(() => vi.advanceTimersByTime(NOTICE_MS));
    expect(pill()).toHaveTextContent("⌘J … Esc to cancel");
    expect(press(C)).toBe(false);
    expect(ran).toHaveBeenCalledWith("new");
  });

  it("names an unbound key that isn't a letter or digit", () => {
    renderKeyboard();
    press(leader);
    expect(press({ key: " ", code: "Space" })).toBe(false);
    expect(pill()).toHaveTextContent("⌘J Space: not a command");
  });

  it.each([
    ["C", C],
    ["⌘P", { key: "p", code: "KeyP", metaKey: true }],
  ])("swallows the second key's auto-repeats (%s held)", (_, second) => {
    renderKeyboard();
    press(leader);
    expect(press(second)).toBe(false);
    expect(press({ ...second, repeat: true })).toBe(false);
    expect(press({ ...second, repeat: true })).toBe(false);
    expect(composerKeys).not.toHaveBeenCalled();
    // Pressed afresh, the key goes through.
    expect(press(C)).toBe(true);
    expect(composerKeys).toHaveBeenCalledTimes(1);
  });

  it("swallows an unbound key pressed with ⌘", () => {
    renderKeyboard();
    press(leader);
    expect(press({ key: "x", code: "KeyX", metaKey: true })).toBe(false);
    expect(composerKeys).not.toHaveBeenCalled();
    expect(pill()).toHaveTextContent("⌘J X: not a command");
  });

  it("never times out", () => {
    vi.useFakeTimers();
    renderKeyboard();
    press(leader);
    act(() => vi.advanceTimersByTime(NOTICE_MS * 10));
    expect(pill()).toHaveTextContent("⌘J … Esc to cancel");
    expect(press(C)).toBe(false);
    expect(ran).toHaveBeenCalledWith("new");
  });

  it("ignores keydowns with no key, as Chrome's autofill sends", () => {
    const errors = vi.fn();
    window.addEventListener("error", errors);
    renderKeyboard();
    press(leader);
    fireEvent(document.activeElement as Element, new Event("keydown", { bubbles: true }));
    window.removeEventListener("error", errors);
    expect(errors).not.toHaveBeenCalled();
    expect(pill()).toHaveTextContent("⌘J … Esc to cancel");
  });

  it("treats Shift or Alt on the second key, and a command with no handler, as unbound", () => {
    renderKeyboard();
    press(leader);
    expect(press({ key: "C", code: "KeyC", shiftKey: true })).toBe(false);
    expect(pill()).toHaveTextContent("⌘J ⇧C: not a command");
    press(leader);
    expect(press({ key: "ç", code: "KeyC", altKey: true })).toBe(false);
    expect(pill()).toHaveTextContent("⌘J ⌥C: not a command");
    press(leader);
    expect(press({ key: "c", code: "KeyC", ctrlKey: true })).toBe(false);
    expect(pill()).toHaveTextContent("⌘J ⌃C: not a command");
    press(leader);
    expect(press({ key: "p", code: "KeyP" })).toBe(false);
    expect(pill()).toHaveTextContent("⌘J P: not a command");
    expect(ran).not.toHaveBeenCalled();
  });

  it("stays pending over bare modifiers and ⌘J repeats", () => {
    renderKeyboard();
    press(leader);
    expect(press({ key: "Meta", code: "MetaLeft", metaKey: true })).toBe(true);
    press({ key: "Shift", code: "ShiftLeft", shiftKey: true });
    press({ key: "Control", code: "ControlLeft", ctrlKey: true });
    press({ key: "Alt", code: "AltLeft", altKey: true });
    expect(press({ ...leader, repeat: true })).toBe(false);
    expect(pill()).toHaveTextContent("⌘J … Esc to cancel");
    press(C);
    expect(ran).toHaveBeenCalledWith("new");
  });

  it.each([
    ["isComposing", { isComposing: true }],
    ["keyCode 229", { keyCode: 229 }],
  ])("leaves IME keydowns (%s) alone and cancels", (_, ime) => {
    renderKeyboard();
    press(leader);
    expect(press({ ...C, ...ime })).toBe(true);
    expect(composerKeys).toHaveBeenCalledTimes(1);
    expect(pill()).toBeNull();
    expect(ran).not.toHaveBeenCalled();
    expect(press({ ...leader, ...ime })).toBe(true);
    expect(pill()).toBeNull();
  });
});

describe("useCommand", () => {
  function New({ name }: { name: string }) {
    useCommand("conversation.new", () => ran(name));
    return null;
  }

  const renderNew = (first: boolean, second: boolean) => (
    <KeyboardProvider>
      {first && <New name="first" />}
      {second && <New name="second" />}
    </KeyboardProvider>
  );

  it("unregisters when its component unmounts", () => {
    const { rerender } = render(renderNew(true, false));
    rerender(renderNew(false, false));
    press(leader);
    press(C);
    expect(pill()).toHaveTextContent("⌘J C: not a command");
    expect(ran).not.toHaveBeenCalled();
  });

  it("leaves a later handler for the same command in place when an earlier one unmounts", () => {
    const { rerender } = render(renderNew(true, true));
    rerender(renderNew(false, true));
    press(leader);
    press(C);
    expect(ran.mock.calls).toEqual([["second"]]);
  });
});

describe("direct digits", () => {
  it("go to a position in the app context", () => {
    stubMatchMedia((query) => query === APP_QUERY);
    renderKeyboard();
    expect(press({ key: "2", code: "Digit2", metaKey: true })).toBe(false);
    expect(ran).toHaveBeenCalledWith("goTo 2");
    expect(composerKeys).not.toHaveBeenCalled();
  });

  it("are left to the browser in a tab and under Safari rules", () => {
    renderKeyboard();
    expect(press({ key: "2", code: "Digit2", metaKey: true })).toBe(true);
    stubUserAgent(USER_AGENTS.macSafari);
    stubMatchMedia((query) => query === APP_QUERY);
    expect(press({ key: "2", code: "Digit2", metaKey: true })).toBe(true);
    expect(ran).not.toHaveBeenCalled();
  });

  it("need the modifier alone", () => {
    stubMatchMedia((query) => query === APP_QUERY);
    renderKeyboard();
    expect(press({ key: "2", code: "Digit2", metaKey: true, shiftKey: true })).toBe(true);
    expect(press({ key: "2", code: "Digit2" })).toBe(true);
    expect(ran).not.toHaveBeenCalled();
  });
});

describe("direct ⌘B", () => {
  it("toggles the sidebar in a tab, in the app context and under Safari rules", () => {
    renderKeyboard();
    expect(press(cmdB)).toBe(false);
    stubMatchMedia((query) => query === APP_QUERY);
    expect(press(cmdB)).toBe(false);
    stubUserAgent(USER_AGENTS.macSafari);
    expect(press(cmdB)).toBe(false);
    expect(ran.mock.calls).toEqual([["sidebar"], ["sidebar"], ["sidebar"]]);
    expect(composerKeys).not.toHaveBeenCalled();
  });

  it("uses Ctrl+B on Windows and Linux", () => {
    stubUserAgent(USER_AGENTS.windowsEdge);
    renderKeyboard();
    expect(press(cmdB)).toBe(true);
    expect(press({ ...cmdB, metaKey: false, ctrlKey: true })).toBe(false);
    expect(ran.mock.calls).toEqual([["sidebar"]]);
  });

  it("needs the modifier alone", () => {
    renderKeyboard();
    expect(press({ ...cmdB, shiftKey: true })).toBe(true);
    expect(press({ key: "b", code: "KeyB" })).toBe(true);
    expect(ran).not.toHaveBeenCalled();
  });
});

describe("while an overlay is open", () => {
  const overlays: Array<[string, ReactNode]> = [
    [
      "modal dialog",
      <Dialog key="dialog" open>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Some dialog.</DialogDescription>
        </DialogContent>
      </Dialog>,
    ],
    [
      "non-modal sheet",
      <Sheet key="sheet" open modal={false}>
        <SheetContent>
          <SheetTitle>Trust</SheetTitle>
          <SheetDescription>Some sheet.</SheetDescription>
        </SheetContent>
      </Sheet>,
    ],
    [
      "popover",
      <Popover key="popover" open>
        <PopoverAnchor />
        <PopoverContent>Models</PopoverContent>
      </Popover>,
    ],
    [
      "menu",
      <DropdownMenu key="menu" open>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    ],
  ];

  it.each(overlays)("turns shortcuts off over a %s, except help", async (_, overlay) => {
    stubMatchMedia((query) => query === APP_QUERY);
    renderKeyboard(overlay);
    press(leader);
    expect(press(C)).toBe(false);
    expect(ran).not.toHaveBeenCalled();
    expect(pill()).toHaveTextContent("⌘J C is off while a dialog is open");
    expect(press({ key: "2", code: "Digit2", metaKey: true })).toBe(true);
    expect(press(cmdB)).toBe(true);
    expect(ran).not.toHaveBeenCalled();

    press(leader);
    press(H);
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    press(leader);
    press(H);
    await waitFor(() => expect(help()).toBeNull());
  });

  it("shows the off notice for 1.5 s", () => {
    vi.useFakeTimers();
    renderKeyboard(overlays[0]?.[1]);
    press(leader);
    press(C);
    act(() => vi.advanceTimersByTime(NOTICE_MS - 1));
    expect(pill()).toHaveTextContent("is off while a dialog is open");
    act(() => vi.advanceTimersByTime(1));
    expect(pill()).toBeNull();
  });

  it("leaves the slash menu's listbox out", () => {
    renderKeyboard(<div role="listbox" aria-label="Commands" data-state="open" />);
    press(leader);
    press(C);
    expect(ran).toHaveBeenCalledWith("new");
  });

  it("shows the pill above a modal dialog, not aria-hidden", () => {
    renderKeyboard(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Some dialog.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    // The modal hides the rest of the page.
    expect(screen.queryByRole("textbox", { name: "Composer" })).toBeNull();
    press(leader);
    expect(screen.getByRole("status")).toHaveTextContent("⌘J … Esc to cancel");
    expect(screen.getByRole("status").closest("[aria-hidden=true]")).toBeNull();
  });

  it("keeps the pill out of aria-hidden when a modal dialog opens while it shows", () => {
    const dialog = (open: boolean) => (
      <KeyboardProvider>
        <Commands />
        <Dialog open={open}>
          <DialogContent>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>Some dialog.</DialogDescription>
          </DialogContent>
        </Dialog>
      </KeyboardProvider>
    );
    const { rerender } = render(dialog(false));
    press(leader);
    rerender(dialog(true));
    expect(screen.getByRole("status")).toHaveTextContent("⌘J … Esc to cancel");
    expect(screen.getByRole("status").closest("[aria-hidden=true]")).toBeNull();
    press(C);
    expect(screen.getByRole("status")).toHaveTextContent("⌘J C is off while a dialog is open");
    expect(screen.getByRole("status").closest("[aria-hidden=true]")).toBeNull();
  });
});

describe("help screen", () => {
  /** The keys in `command`'s row of the help screen. */
  function keysOf(command: string): string {
    const row = within(help() as HTMLElement)
      .getByText(command)
      .closest("tr") as HTMLTableRowElement;
    return row.cells[1]?.textContent ?? "";
  }

  async function openHelp() {
    press(leader);
    press(H);
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  }

  it("lists every command by section, with direct digits in the Chrome app window", async () => {
    stubMatchMedia((query) => query === APP_QUERY);
    renderKeyboard();
    await openHelp();
    const dialog = help() as HTMLElement;
    expect(dialog).toHaveTextContent("Press ⌘J, then a key, with or without ⌘ held. Esc cancels.");
    expect(
      within(dialog)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Conversations", "View", "Help"]);
    const conversations = within(dialog).getByRole("table", { name: "Conversations" });
    expect(
      within(conversations)
        .getAllByRole("row")
        .map((row) => row.textContent),
    ).toEqual([
      "New conversation⌘J C",
      "Review PR⌘J R",
      "Previous conversation⌘J P",
      "Next conversation⌘J N",
      "Go to conversation 1–9⌘J 1–9⌘1–9",
    ]);
    expect(
      within(within(dialog).getByRole("table", { name: "View" })).getByRole("row"),
    ).toHaveTextContent("Toggle sidebar⌘J B⌘B");
    expect(
      within(within(dialog).getByRole("table", { name: "Help" })).getByRole("row"),
    ).toHaveTextContent("Keyboard shortcuts⌘J H");
    expect(dialog).not.toHaveTextContent("without ⌘:");
  });

  it("leaves direct digits out of a tab, but not ⌘B", async () => {
    renderKeyboard();
    await openHelp();
    expect(keysOf("Go to conversation 1–9")).toBe("⌘J 1–9");
    expect(keysOf("Toggle sidebar")).toBe("⌘J B⌘B");
  });

  it("labels Ctrl on Windows and Linux", async () => {
    stubUserAgent(USER_AGENTS.linuxChrome);
    stubMatchMedia((query) => query === APP_QUERY);
    renderKeyboard();
    press({ ...leader, metaKey: false, ctrlKey: true });
    press(H);
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(help()).toHaveTextContent("Press Ctrl+J, then a key, with or without Ctrl held.");
    expect(keysOf("New conversation")).toBe("Ctrl+J C");
    expect(keysOf("Go to conversation 1–9")).toBe("Ctrl+J 1–9Ctrl+1–9");
    expect(keysOf("Toggle sidebar")).toBe("Ctrl+J BCtrl+B");
  });

  it("has the digit note under Safari rules, even in the app context", async () => {
    stubUserAgent(USER_AGENTS.macSafari);
    stubMatchMedia((query) => query === APP_QUERY);
    renderKeyboard();
    await openHelp();
    expect(keysOf("Go to conversation 1–9")).toBe("⌘J 1–9");
    expect(keysOf("Toggle sidebar")).toBe("⌘J B⌘B");
    expect(help()).toHaveTextContent(
      "After ⌘J, press the digit without ⌘: this browser keeps ⌘1–9 for itself.",
    );
  });

  it("closes on Esc", async () => {
    renderKeyboard();
    await openHelp();
    press({ key: "Escape", code: "Escape" });
    await waitFor(() => expect(help()).toBeNull());
  });
});
