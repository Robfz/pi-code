# Keyboard shortcuts

pi-code's keyboard layer: shared shortcut infrastructure, switching between live conversations, starting a new one and a help screen. Decisions and rationale: [`../../maps/2026-11-05-keyboard.md`](../../maps/2026-11-05-keyboard.md). Where this document overlaps `03-web-client.md` or `05-desktop.md`, it takes precedence. The command palette (⌘K) is out of scope; it will list and run the same commands.

Every shortcut is a tmux-style **leader**: ⌘J, then one plain key. The installed Chrome app window also takes ⌘1–9 directly. Key handling isn't gated by viewport or pointer: shortcuts work at every size and simply can't fire without a hardware keyboard (F3, F4).

## Platforms and contexts

| Platform | Detected by | Modifier | Leader | Labels |
|---|---|---|---|---|
| macOS, iPadOS | `navigator.userAgent` matches `Macintosh`, `iPhone` or `iPad` (iPadOS Safari reports a Mac, F15; `packages/web/src/sw.ts` tests `Macintosh` the same way) | `metaKey` | ⌘J | ⌘ |
| Windows, Linux | otherwise | `ctrlKey` | Ctrl+J | Ctrl |

The help screen, the pending indicator and the notices show the platform's label; below, ⌘ stands for either.

| Context | Detected by | Bindings |
|---|---|---|
| App | `(display-mode: standalone), (display-mode: window-controls-overlay)` matches. With the title bar hidden, the manifest's `display_override` puts the installed Chrome app in `window-controls-overlay`, where `standalone` alone doesn't match | Leader, plus ⌘1–9 directly, except under Safari rules |
| Tab | otherwise | Leader only, so the browser keeps ⌘1–9 for its tabs |

**Safari rules** (no direct digits; the help screen's digit note) apply when the user agent contains `AppleWebKit/` and not `Chrome/`: Safari, whose Dock and Home Screen web apps are the app context (F15) but never receive ⌘1–9 (F16, F17), and every iPadOS browser, since Chrome, Edge and Firefox there (`CriOS/`, `EdgiOS/`, `FxiOS/`) run on WebKit and are as untested (F14). Every Chromium-engine browser sends `Chrome/`. The check skips `Safari/` and `Version/`: Chrome sends `Safari/` too, and WebKit web views may omit both.

Browsers in scope: Chrome and Safari, on macOS and iPadOS, plus Chrome on Windows and Linux.

## Keymap

| Command (`commands.ts`) | Title | Section | After the leader | Direct (Chrome app window) |
|---|---|---|---|---|
| `conversation.new` | New conversation | Conversations | C | — |
| `conversation.previous` | Previous conversation | Conversations | P | — |
| `conversation.next` | Next conversation | Conversations | N | — |
| `conversation.goTo` | Go to conversation 1–9 | Conversations | 1–9 | ⌘1–9 |
| `help.toggle` | Keyboard shortcuts | Help | H | — |

- The key after the leader counts with or without ⌘ held, and is swallowed: ⌘J ⌘C doesn't copy.
- ⌘J is in neither Chrome's reserved list (F5) nor Safari's (F17), so the page receives it first in tabs and app windows. Chrome binds Ctrl+J and Ctrl+1–9 on Windows but reserves neither.
- The composer's `/hotkeys` stays TUI-only ("Use the TUI for this", `03-web-client.md`): it lists pi's TUI keybindings, which don't apply in the browser (F2).

## Leader

A pending flag in the keyboard provider, with no timeout: the indicator and Esc cover a forgotten leader, as in tmux and VS Code.

| State | Event | Effect |
|---|---|---|
| Idle | ⌘J | Swallowed (`preventDefault`, `stopPropagation`); pending; the indicator shows |
| Idle | ⌘1–9, app context outside Safari rules | Swallowed; `conversation.goTo` |
| Pending | Esc | Swallowed, so it doesn't also dismiss the composer's slash menu or an open dialog; idle |
| Pending | a bound key, with or without ⌘ | Swallowed; idle; the command runs (but see [When shortcuts are off](#when-shortcuts-are-off)) |
| Pending | an unbound key | Swallowed; idle; the notice reads "⌘J X: not a command" |
| Pending | a bare modifier keydown (`Meta`, `Control`, `Shift`, `Alt`) | Ignored; still pending |
| Pending | a repeat of ⌘J (`event.repeat`) | Swallowed, so a held Ctrl+J doesn't reach Chrome's Downloads; still pending |
| Idle, after a second key | repeats of that key (`event.repeat`, same `code`) | Swallowed, so a held ⌘J P doesn't reach the browser's print |
| Pending | window `blur` | Idle |
| Pending | a keydown with `isComposing` or `keyCode === 229` | Not swallowed (the IME keeps it); idle |

**Indicator and notices** share one pill, `role="status"`, fixed at the bottom-right corner (inset by the safe area), `pointer-events-none`, above dialogs, styled as a popover (`--popover`, `--input` hairline). It has three states: pending ("⌘J … Esc to cancel"), the unbound-key notice and the [off-state](#when-shortcuts-are-off) notice, each notice for 1.5 s. It renders through a portal into `document.body` that mounts only while the pill shows, so it is created after a modal's `hideOthers` and isn't `aria-hidden` while a dialog is open. Not a Sonner toast, which would stack per keystroke; bottom-center holds the composer. Keys render as `<kbd>`, styled like the `esc` hint in `packages/web/src/features/conversation/model-picker.tsx`.

## Matching

- **Modifiers.** The leader and direct digits need the platform modifier and no other: no Shift, no Alt (Windows reports AltGr as Ctrl+Alt, so AltGr+J isn't the leader), and on macOS no Ctrl. The second key may carry only the platform modifier; with Shift or Alt it's unbound.
- **Digits** match by `code` (`Digit1`–`Digit9`): AZERTY's digit row types `&é"…`.
- **Letters** (J, C, P, N, H) match by `key`, lower-cased, so they follow the user's layout. When `key` isn't a Latin letter (Cyrillic, Greek), they fall back to `code` (`KeyC` → c).
- **IME.** Keydowns with `isComposing` set or `keyCode === 229` are never handled, and cancel a pending leader; the second check catches Safari's composition-commit key, which arrives without `isComposing`. The composer already ignores `isComposing` keydowns (`packages/web/src/features/conversation/composer.tsx`).

## When shortcuts are off

While a modal, sheet, popover or menu is open, the leader still arms but the only live second key is H (`help.toggle`), so the help screen closes with the key that opened it. Help opens over dialogs, sheets and menus; an open popover (the model picker, `packages/web/src/features/review/branch-picker.tsx`) closes as focus moves into help. Another bound key shows the notice "⌘J C is off while a dialog is open"; direct ⌘1–9 aren't intercepted. This stops ⌘2 from navigating away under an open picker.

"Open" is checked on each keydown in the DOM: an element matching `[role="dialog"][data-state="open"]` or `[role="menu"][data-state="open"]`. Radix sets these on every `DialogContent`, `SheetContent` (modal or not), `PopoverContent` and `DropdownMenuContent` (`packages/web/src/components/ui/`), so no overlay registers itself. That includes the non-modal conversation sheets `DialogHost` (`packages/web/src/features/conversation/dialogs/dialog-host.tsx`) and `TrustSheet` (`packages/web/src/features/conversation/agent-state.tsx`), though the sidebar stays usable beside them (F13). The composer's slash menu is a `role="listbox"`, so it doesn't turn shortcuts off.

## Infrastructure

`packages/web/src/features/keyboard/`:

| File | Holds |
|---|---|
| `commands.ts` | The static command list `{ id, title, section }` (the Keymap table), read by the help screen and a later palette |
| `keymap.ts` | Bindings: leader keys to command ids everywhere, plus the direct digits in the app context outside Safari rules. Context, platform and Safari detection; key and code matching |
| `keyboard-provider.tsx` | `KeyboardProvider`: the handler registry, the leader state, the window listeners, the pill and the help dialog. `useCommand(id, handler)` registers a handler for the component's lifetime; `conversation.goTo`'s handler takes the position (1–9) |
| `shell-commands.tsx` | `ShellCommands`: registers `conversation.new`, `.previous`, `.next` and `.goTo`, and hosts the `ProjectPicker` that `conversation.new` opens |

`AppShell` (`packages/web/src/features/pwa/app-shell.tsx`) renders `KeyboardProvider`, with `ShellCommands` inside it, inside `WorktreeActionsProvider` and `StopOrDeleteProvider`, around the layout div: the picker's `NewWorktreeButton` on repo groups calls `useWorktreeActions()`, which throws outside its provider (`packages/web/src/features/worktrees/worktree-actions.tsx`). The provider mounts one `keydown` listener on `window` in the capture phase, which runs before Radix's document-level Escape listener and React's root listener, so swallowing a key keeps it from the composer, the slash menu and open dialogs. A key bound to a command with no registered handler behaves as unbound. The Active-list commands register from `AppShell`, not from `Sidebar`: `AppShell` unmounts `<Sidebar>` when it's closed, and phone sizes mount it only inside `SidebarSheet` (`packages/web/src/features/sidebar/sidebar-sheet.tsx`) (F12).

## Switch conversation

The list is the sidebar's Active section: live agents (`isLive`) in `compareRecency` order (`packages/protocol/src/recency.ts`; F8), prompted ones by last prompt, then unprompted ones by start time, newest first in each. `ShellCommands` computes it from `useLive` the way `Sidebar`'s non-search branch does: `activeRows(buildSidebarGroups({ agents: Object.values(agents), sessions, pinned: sidebar.pinned, mains: sidebar.mains }))` (`packages/web/src/features/sidebar/sidebar-model.ts`). The current conversation is the route's `agentId` (`useParams({ strict: false })`, as in `Sidebar`), on the conversation, tree and diff routes alike.

Positions ignore the sidebar's search filter.

- **⌘J 1–9** (and ⌘1–9 in the Chrome app window) open the conversation at that position. An empty position does nothing.
- **⌘J N / ⌘J P** step to the next or previous row, wrapping at both ends. From a view outside the Active list (Home, Settings, `/sessions`, an exited or closed conversation) N opens the first row and P the last, as if stepping in from beyond the ends. With no live agent they do nothing.
- **Opening a row** navigates to `/agents/$agentId`, as clicking a live row does. Active rows are always live, so a shortcut never restarts or resumes anything.

## New conversation

⌘J C opens the project picker (`ProjectPicker`, `packages/web/src/features/catalog/project-picker.tsx`) hosted by `ShellCommands`, the same picker as the sidebar's New conversation button, on every route and with the sidebar closed. It opens in place: Esc leaves the user where they were, which navigating to the manifest shortcut's `/?new=1` (`useNewConversationPicker`) would not, since that lands on `/`. Choosing a project opens the agent and navigates to it (`useOpenAgent`).

## Help screen

A dialog (`packages/web/src/components/ui/dialog.tsx`) titled "Keyboard shortcuts", opened by ⌘J H or the entry point, closed by ⌘J H, Esc or its ×.

- **Contents** are generated from `commands.ts` and the current context's bindings in `keymap.ts`: one table per section, each row the command's title and its keys in the platform's labels ("⌘J 1–9", plus "⌘1–9" in the Chrome app window). A line above the tables says the leader is ⌘J followed by a key, with or without ⌘, and that Esc cancels. Under Safari rules, a note says to press the digit without ⌘.
- **Entry point:** a ghost icon button (`KeyboardIcon`, `aria-label` and `title` "Keyboard shortcuts") rendered by `AppShell`. Docked, it follows the toggle in `Sidebar`'s `action`, at the row's right end (`ml-auto`), and `action`'s docstring names both buttons; in the collapsed rail it sits under the toggle. It exists only where the docked sidebar does (`DESKTOP_QUERY`, 64rem, `packages/web/src/lib/use-media-query.ts`), so it is hidden at phone sizes and on portrait iPads; `SidebarSheet` doesn't get it. Its title carries no keys: v1 has no tooltip or menu hints.

## Tests

- `keymap.ts`: key and code matching across QWERTY, AZERTY, Dvorak and Cyrillic events; modifiers including AltGr; platform and Safari-rules detection over user-agent fixtures (macOS Safari, Chrome, Edge, iPad `CriOS/`); context from `matchMedia`.
- Provider: pending, Esc, blur, bound and unbound keys with and without ⌘, bare modifiers and repeats, IME `isComposing` and 229, the off state with each overlay kind, the help exception, the slash menu left alone; the pill's three states, and the pill not `aria-hidden` over a modal dialog.
- `ShellCommands`: positions, wrapping, entry from outside the Active list, empty positions, the picker with the sidebar closed, and the picker listing a repo project.
- Help screen per context and platform; the entry point's absence below `DESKTOP_QUERY`.

## Limitations

- In Safari, the digit after ⌘J must be pressed without ⌘; with ⌘ held, Safari switches tabs and the page never sees the key (F16, F17).
- A 10th live agent and later have no position key; previous/next still reach them.
- Positions follow prompts: sending a prompt moves that agent to 1 and renumbers the rest (F8), and a conversation started with ⌘J C stays below every prompted one until its first prompt. Positions are shown nowhere but the sidebar's order.
- On Windows and Linux, which keys Chrome keeps for itself comes from Chromium's source (F5); only macOS was tested by hand (F16, F17).
- The leader costs two keystrokes per action, by design: no single modifier family is free of system, browser and layout clashes (F9).

### Open question: iPad

Whether ⌘J and ⌘1–9 reach the page in iPad Safari and in iPad Home Screen apps is untested (F14); a manual keydown test with a hardware keyboard is pending, and Chrome, Edge and Firefox on iPadOS share WebKit and the same unknown. Until then every iPadOS browser gets Safari rules: the leader with a plain digit, no direct digits. If ⌘J doesn't reach the page there, no shortcut works on iPad, and the help entry point on a landscape iPad (≥64rem) lists keys that do nothing. Holding ⌘ on iPad shows the system shortcut overlay, which pages can't add to (F15).
