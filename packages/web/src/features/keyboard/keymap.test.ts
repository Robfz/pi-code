import { afterEach, describe, expect, it, vi } from "vitest";
import { stubMatchMedia } from "@/test/dom-stubs";
import { USER_AGENTS } from "@/test/user-agents";
import {
  APP_QUERY,
  detectContext,
  detectPlatform,
  hasModifierOnly,
  hasSafariRules,
  isComposing,
  isLeader,
  isPlainOrModified,
  keyLabel,
  keymapFor,
  keyOf,
  shortcutsFor,
} from "./keymap";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

afterEach(() => vi.unstubAllGlobals());

describe("keyOf", () => {
  it("matches QWERTY letters and digits", () => {
    expect(keyOf(key({ key: "c", code: "KeyC" }))).toBe("c");
    expect(keyOf(key({ key: "1", code: "Digit1" }))).toBe("1");
    expect(keyOf(key({ key: "J", code: "KeyJ" }))).toBe("j");
  });

  it("matches AZERTY digits by code and letters by key", () => {
    expect(keyOf(key({ key: "&", code: "Digit1" }))).toBe("1");
    expect(keyOf(key({ key: "é", code: "Digit2" }))).toBe("2");
    expect(keyOf(key({ key: "ç", code: "Digit9" }))).toBe("9");
    // AZERTY's A is QWERTY's Q.
    expect(keyOf(key({ key: "a", code: "KeyQ" }))).toBe("a");
  });

  it("follows Dvorak by key", () => {
    expect(keyOf(key({ key: "j", code: "KeyC" }))).toBe("j");
    expect(keyOf(key({ key: "c", code: "KeyI" }))).toBe("c");
    // Punctuation on a letter position isn't that letter.
    expect(keyOf(key({ key: ",", code: "KeyW" }))).toBeUndefined();
  });

  it("falls back to code for Cyrillic and Greek letters", () => {
    expect(keyOf(key({ key: "о", code: "KeyJ" }))).toBe("j");
    expect(keyOf(key({ key: "с", code: "KeyC" }))).toBe("c");
    expect(keyOf(key({ key: "ψ", code: "KeyC" }))).toBe("c");
  });

  it("names nothing else", () => {
    expect(keyOf(key({ key: "0", code: "Digit0" }))).toBeUndefined();
    expect(keyOf(key({ key: "Enter", code: "Enter" }))).toBeUndefined();
    expect(keyOf(key({ key: "Meta", code: "MetaLeft" }))).toBeUndefined();
  });
});

describe("keyLabel", () => {
  it("names keys bindings don't by event.key, Space by name", () => {
    expect(keyLabel(key({ key: " ", code: "Space" }), "apple")).toBe("Space");
    expect(keyLabel(key({ key: "Enter", code: "Enter" }), "apple")).toBe("Enter");
    expect(keyLabel(key({ key: ",", code: "Comma" }), "other")).toBe(",");
    expect(keyLabel(key({ key: "0", code: "Digit0" }), "apple")).toBe("0");
  });

  it("upper-cases letters and digits, plain or with the platform's modifier alone", () => {
    expect(keyLabel(key({ key: "c", code: "KeyC" }), "apple")).toBe("C");
    expect(keyLabel(key({ key: "c", code: "KeyC", metaKey: true }), "apple")).toBe("C");
    expect(keyLabel(key({ key: "&", code: "Digit1", ctrlKey: true }), "other")).toBe("1");
  });

  it("prefixes any other modifiers held, in the platform's labels", () => {
    expect(keyLabel(key({ key: "C", code: "KeyC", shiftKey: true }), "apple")).toBe("⇧C");
    expect(keyLabel(key({ key: "c", code: "KeyC", ctrlKey: true }), "apple")).toBe("⌃C");
    expect(keyLabel(key({ key: "C", code: "KeyC", metaKey: true, shiftKey: true }), "apple")).toBe(
      "⇧⌘C",
    );
    expect(keyLabel(key({ key: "C", code: "KeyC", shiftKey: true }), "other")).toBe("Shift+C");
    expect(keyLabel(key({ key: "c", code: "KeyC", ctrlKey: true, altKey: true }), "other")).toBe(
      "Ctrl+Alt+C",
    );
    expect(keyLabel(key({ key: "c", code: "KeyC", metaKey: true }), "other")).toBe("Meta+C");
  });
});

describe("modifiers", () => {
  const j = { key: "j", code: "KeyJ" };

  it("takes ⌘ alone on Apple platforms", () => {
    expect(isLeader(key({ ...j, metaKey: true }), "apple")).toBe(true);
    expect(isLeader(key({ ...j, ctrlKey: true }), "apple")).toBe(false);
    expect(isLeader(key({ ...j, metaKey: true, ctrlKey: true }), "apple")).toBe(false);
    expect(isLeader(key({ ...j, metaKey: true, shiftKey: true }), "apple")).toBe(false);
    expect(isLeader(key({ ...j, metaKey: true, altKey: true }), "apple")).toBe(false);
    expect(isLeader(key(j), "apple")).toBe(false);
  });

  it("takes Ctrl alone elsewhere, not AltGr", () => {
    expect(isLeader(key({ ...j, ctrlKey: true }), "other")).toBe(true);
    expect(isLeader(key({ ...j, metaKey: true }), "other")).toBe(false);
    // Windows reports AltGr as Ctrl+Alt.
    expect(isLeader(key({ ...j, ctrlKey: true, altKey: true }), "other")).toBe(false);
    expect(isLeader(key({ ...j, ctrlKey: true, shiftKey: true }), "other")).toBe(false);
  });

  it("takes the leader on other layouts", () => {
    expect(isLeader(key({ key: "j", code: "KeyC", metaKey: true }), "apple")).toBe(true);
    expect(isLeader(key({ key: "о", code: "KeyJ", ctrlKey: true }), "other")).toBe(true);
  });

  it("lets the second key carry the platform's modifier or none", () => {
    const c = { key: "c", code: "KeyC" };
    expect(isPlainOrModified(key(c), "apple")).toBe(true);
    expect(isPlainOrModified(key({ ...c, metaKey: true }), "apple")).toBe(true);
    expect(isPlainOrModified(key({ ...c, ctrlKey: true }), "apple")).toBe(false);
    expect(isPlainOrModified(key({ ...c, shiftKey: true }), "apple")).toBe(false);
    expect(isPlainOrModified(key({ ...c, altKey: true }), "apple")).toBe(false);
    expect(isPlainOrModified(key({ ...c, ctrlKey: true }), "other")).toBe(true);
    expect(isPlainOrModified(key({ ...c, ctrlKey: true, altKey: true }), "other")).toBe(false);
  });

  it("takes direct digits with the modifier alone", () => {
    const one = { key: "1", code: "Digit1" };
    expect(hasModifierOnly(key({ ...one, metaKey: true }), "apple")).toBe(true);
    expect(hasModifierOnly(key({ ...one, metaKey: true, shiftKey: true }), "apple")).toBe(false);
  });

  it("spots IME keydowns", () => {
    expect(isComposing(key({ key: "a", isComposing: true }))).toBe(true);
    expect(isComposing(key({ key: "Enter", keyCode: 229 }))).toBe(true);
    expect(isComposing(key({ key: "a" }))).toBe(false);
  });
});

describe("detection", () => {
  it("reads the platform from the user agent", () => {
    expect(detectPlatform(USER_AGENTS.macSafari)).toBe("apple");
    expect(detectPlatform(USER_AGENTS.macChrome)).toBe("apple");
    expect(detectPlatform(USER_AGENTS.iPadChrome)).toBe("apple");
    expect(detectPlatform(USER_AGENTS.windowsEdge)).toBe("other");
    expect(detectPlatform(USER_AGENTS.linuxChrome)).toBe("other");
  });

  it("gives Safari and every iPadOS browser the Safari rules", () => {
    expect(hasSafariRules(USER_AGENTS.macSafari)).toBe(true);
    expect(hasSafariRules(USER_AGENTS.iPadChrome)).toBe(true);
    expect(hasSafariRules(USER_AGENTS.macChrome)).toBe(false);
    expect(hasSafariRules(USER_AGENTS.windowsEdge)).toBe(false);
    expect(hasSafariRules(USER_AGENTS.linuxChrome)).toBe(false);
  });

  it("is in the app context in standalone or window-controls-overlay display", () => {
    stubMatchMedia((query) => query === APP_QUERY);
    expect(detectContext()).toBe("app");
    stubMatchMedia(() => false);
    expect(detectContext()).toBe("tab");
    expect(APP_QUERY).toContain("(display-mode: standalone)");
    expect(APP_QUERY).toContain("(display-mode: window-controls-overlay)");
  });
});

describe("keymapFor", () => {
  it("adds direct digits in the app context only, never under Safari rules", () => {
    expect(keymapFor("app", false).direct.get("3")).toEqual({
      command: "conversation.goTo",
      position: 3,
    });
    expect(keymapFor("app", true).direct.size).toBe(0);
    expect(keymapFor("tab", false).direct.size).toBe(0);
    for (const keymap of [keymapFor("app", false), keymapFor("tab", true)]) {
      expect(keymap.leader.get("c")?.command).toBe("conversation.new");
      expect(keymap.leader.get("p")?.command).toBe("conversation.previous");
      expect(keymap.leader.get("n")?.command).toBe("conversation.next");
      expect(keymap.leader.get("h")?.command).toBe("help.toggle");
      expect(keymap.leader.get("9")).toEqual({ command: "conversation.goTo", position: 9 });
    }
  });

  it("labels each command's keys", () => {
    expect(shortcutsFor("conversation.new", keymapFor("app", false), "apple")).toEqual([
      ["⌘J", "C"],
    ]);
    expect(shortcutsFor("conversation.goTo", keymapFor("app", false), "apple")).toEqual([
      ["⌘J", "1–9"],
      ["⌘1–9"],
    ]);
    expect(shortcutsFor("conversation.goTo", keymapFor("tab", false), "other")).toEqual([
      ["Ctrl+J", "1–9"],
    ]);
  });
});
