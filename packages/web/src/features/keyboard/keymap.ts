/**
 * Keys per context, and the platform, context and Safari detection and key matching behind them
 * (`docs/design/10-keyboard.md`, "Platforms and contexts", "Matching").
 */

import type { CommandId } from "./commands";

/** `app`: an installed app window (or a Safari Dock / Home Screen app); `tab`: a browser tab. */
export type Context = "app" | "tab";

/**
 * Hiding the installed Chrome app's title bar puts it in `window-controls-overlay`, where
 * `standalone` alone doesn't match.
 */
export const APP_QUERY = "(display-mode: standalone), (display-mode: window-controls-overlay)";

/** `apple`: ⌘ is the shortcut modifier; `other` (Windows, Linux): Ctrl. */
export type Platform = "apple" | "other";

export function detectContext(): Context {
  return typeof window.matchMedia === "function" && window.matchMedia(APP_QUERY).matches
    ? "app"
    : "tab";
}

/** iPadOS Safari reports a Mac, so `Macintosh` covers it. */
export function detectPlatform(userAgent = navigator.userAgent): Platform {
  return /Macintosh|iPhone|iPad/.test(userAgent) ? "apple" : "other";
}

/**
 * Safari and every iPadOS browser (all WebKit): no direct ⌘1–9, which never reach the page there.
 * Every Chromium browser sends `Chrome/`; `Safari/` and `Version/` prove nothing, as Chrome sends
 * the first and WebKit web views may omit both.
 */
export function hasSafariRules(userAgent = navigator.userAgent): boolean {
  return userAgent.includes("AppleWebKit/") && !userAgent.includes("Chrome/");
}

const COMMAND = "⌘";
const CTRL = "Ctrl";

export function modifierLabel(platform: Platform): string {
  return platform === "apple" ? COMMAND : CTRL;
}

/** Between a modifier's label and what follows: nothing on Apple platforms, `+` elsewhere. */
const separator = (platform: Platform) => (platform === "apple" ? "" : "+");

/** `key` with the platform's modifier, as labelled: `⌘J`, `Ctrl+J`. */
export function chordLabel(platform: Platform, key: string): string {
  return modifierLabel(platform) + separator(platform) + key;
}

/** The leader as labelled: `⌘J`, `Ctrl+J`. */
export function leaderLabel(platform: Platform): string {
  return chordLabel(platform, LEADER_KEY.toUpperCase());
}

/** What a key runs; `position` is `conversation.goTo`'s. */
export interface Binding {
  command: CommandId;
  position?: number;
}

export interface Keymap {
  /** Second keys after the leader. */
  leader: ReadonlyMap<string, Binding>;
  /** Keys taken with the platform's modifier alone, without the leader. */
  direct: ReadonlyMap<string, Binding>;
}

/** The leader's own key, after the platform's modifier. */
export const LEADER_KEY = "j";

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
const goTo = DIGITS.map((digit): [string, Binding] => [
  digit,
  { command: "conversation.goTo", position: Number(digit) },
]);
const toggleSidebar: [string, Binding] = ["b", { command: "sidebar.toggle" }];

const LEADER = new Map<string, Binding>([
  ["c", { command: "conversation.new" }],
  ["r", { command: "pr.review" }],
  ["p", { command: "conversation.previous" }],
  ["n", { command: "conversation.next" }],
  ...goTo,
  toggleSidebar,
  ["h", { command: "help.toggle" }],
]);

const WITHOUT_DIRECT_DIGITS: Keymap = { leader: LEADER, direct: new Map([toggleSidebar]) };
const WITH_DIRECT_DIGITS: Keymap = { leader: LEADER, direct: new Map([...goTo, toggleSidebar]) };

/**
 * The leader and direct ⌘B everywhere, plus direct ⌘1–9 in the app context outside Safari rules:
 * a tab's browser keeps ⌘1–9 for switching tabs, and Safari never delivers them to the page.
 */
export function keymapFor(context: Context, safariRules: boolean): Keymap {
  const directDigits = context === "app" && !safariRules;
  return directDigits ? WITH_DIRECT_DIGITS : WITHOUT_DIRECT_DIGITS;
}

/**
 * The key as bindings name it: `1`–`9` by `code` (AZERTY's digit row types `&é"…`), letters by
 * `key` lower-cased so they follow the layout, or by `code` when `key` is a non-Latin letter.
 */
export function keyOf(event: KeyboardEvent): string | undefined {
  const digit = /^Digit([1-9])$/.exec(event.code);
  if (digit) return digit[1];
  const key = event.key.toLowerCase();
  if (/^[a-z]$/.test(key)) return key;
  const letter = /^Key([A-Z])$/.exec(event.code);
  if (letter && /^\p{L}$/u.test(event.key)) return letter[1]?.toLowerCase();
  return undefined;
}

/** Each modifier flag with its Apple and other-platform labels. */
const MODIFIERS = [
  ["ctrlKey", "⌃", CTRL],
  ["altKey", "⌥", "Alt"],
  ["shiftKey", "⇧", "Shift"],
  ["metaKey", COMMAND, "Meta"],
] as const;

/**
 * The key as the pill names it. A letter or digit held with modifiers a second key can't take
 * carries them, so ⇧C doesn't read as C.
 */
export function keyLabel(event: KeyboardEvent, platform: Platform): string {
  const key = keyOf(event);
  if (key === undefined) return event.key === " " ? "Space" : event.key;
  if (isPlainOrModified(event, platform)) return key.toUpperCase();
  const held = MODIFIERS.filter(([flag]) => event[flag]);
  const labels = held.map(
    ([, apple, other]) => (platform === "apple" ? apple : other) + separator(platform),
  );
  return labels.join("") + key.toUpperCase();
}

/**
 * The platform's modifier and no other: no Shift, no Alt (Windows reports AltGr as Ctrl+Alt),
 * and not both ⌘ and Ctrl.
 */
export function hasModifierOnly(event: KeyboardEvent, platform: Platform): boolean {
  if (event.shiftKey || event.altKey) return false;
  return platform === "apple" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** A second key counts with the platform's modifier or with none. */
export function isPlainOrModified(event: KeyboardEvent, platform: Platform): boolean {
  const none = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
  return none || hasModifierOnly(event, platform);
}

export function isLeader(event: KeyboardEvent, platform: Platform): boolean {
  return hasModifierOnly(event, platform) && keyOf(event) === LEADER_KEY;
}

/** `keyCode` 229 catches Safari's composition-commit key, which comes without `isComposing`. */
export function isComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt"]);

export function isBareModifier(event: KeyboardEvent): boolean {
  return MODIFIER_KEYS.has(event.key);
}

/**
 * `keys` as labelled, several as a range from the first to the last, which suits goTo's digits,
 * the only command with several: `["c"]` → `C`, `["1", …, "9"]` → `1–9`.
 */
function keysLabel(keys: readonly string[]): string {
  const first = keys[0]?.toUpperCase() ?? "";
  return keys.length > 1 ? `${first}–${keys.at(-1)?.toUpperCase()}` : first;
}

/**
 * A command's shortcuts in `keymap`, each as the keys pressed in turn: `[["⌘J", "1–9"], ["⌘1–9"]]`.
 */
export function shortcutsFor(id: CommandId, keymap: Keymap, platform: Platform): string[][] {
  const keysOf = (map: ReadonlyMap<string, Binding>) =>
    [...map].flatMap(([key, binding]) => (binding.command === id ? [key] : []));
  const leader = keysOf(keymap.leader);
  const direct = keysOf(keymap.direct);
  return [
    ...(leader.length > 0 ? [[leaderLabel(platform), keysLabel(leader)]] : []),
    ...(direct.length > 0 ? [[chordLabel(platform, keysLabel(direct))]] : []),
  ];
}
