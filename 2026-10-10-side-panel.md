<!-- pi:map -->
# pi-code — Side panel: ordering, collapse, pins: decision map

Builds on `maps/2026-09-30-desktop.md` (Sidebar) and `maps/2026-09-30-worktrees.md` (grouping).

## Scope & context
- [settled] Three changes in scope: clicking a conversation shouldn't count as interaction; groups collapsible; pinned repos sorted alphabetically — user
- [settled] Added to scope: worktree sub-groups inside a repo collapse individually — user
- [settled] Map lives at the worktree root — user

## Findings
- [settled] F1: Clicking a free session or exited agent starts/restarts it, setting `startedAt = now`; row activity is `max(startedAt, updatedAt)`, so the row and its group jump to the top. Clicking a live row reorders nothing. Opening a conversation also acks attention (clears finished/failed mark) — acknowledged
- [settled] F2: Groups are plain folders or repos (with main/worktree sub-groups), ordered by most recent activity; nothing sidebar-related is persisted anywhere today (no localStorage, no server state) — acknowledged
- [settled] F3: The server can derive each session's last user-prompt timestamp in the same file scan that gives `updatedAt` (last entry of any kind); this covers prompts sent from the pi TUI too — acknowledged
- [settled] F4: Grouping/sorting (`groupListing`) is shared by the sidebar, Home, /sessions and the project picker, and the 7-day sidebar window is cut on `updatedAt` (any entry) — acknowledged
- [settled] F5: The idle sweep closes agents not streaming whose `max(startedAt, updatedAt)` is ≥7 days old, reusing the window constant `CATALOG_WINDOW_MS` (`idle-sweep.ts`) — acknowledged
- [settled] F6: Locally there are 74 session files (31 MB); dropping the window sends every session summary in the SSE catalog frame — small at this scale — acknowledged
- [settled] F7: The web client has no auto-close of its own; the only idle close is the server sweep (plus its docs in `docs/design/05-desktop.md`, "Idle sweep") — acknowledged
- [settled] F8: Group header actions (+, new worktree) are always visible today; no hover-reveal pattern exists in the sidebar, and touch devices (phone sheet, iPad) have no hover — acknowledged

## Ordering ("interaction")
- [settled] The problem is reordering: opening a conversation must not move its row/group to the top; attention clearing on open stays as is — user
- [settled] Sending a prompt is what counts as interaction — user
- [settled] Only user prompts bump ordering; agent output doesn't — user
- [settled] A conversation with no prompt yet sorts at the bottom of its group — user
- [settled] Unprompted conversations sort newest-created first below prompted ones; all-unprompted groups likewise by their newest creation, below prompted groups — agent's call, delegated by user
- [settled] A group whose conversations have no prompts at all sorts at the bottom among groups — user
- [settled] Prompt-only ordering applies everywhere: sidebar, Home, /sessions, project picker — user
- [settled] Drop the 7-day sidebar window; list every session (deletion now exists for pruning) — user
- [settled] Idle sweep stays as is (7 days, stops agents, doesn't delete); it keeps its own constant once the sidebar window goes — user

## Collapse
- [settled] Repo groups, plain folder groups and worktree sub-groups each collapse independently — user
- [settled] The main checkout sub-group doesn't collapse on its own; it hides with its repo — user
- [settled] Clicking the group header toggles collapse (header action buttons excluded) — user
- [settled] New groups start expanded — user
- [settled] Search temporarily expands collapsed groups; they recollapse when search clears; opening a result in a collapsed group uncollapses it for good — user
- [settled] Opening a conversation by any route (Home, push, URL) uncollapses its group(s) — user
- [settled] State for groups that go away is forgotten, not kept for a reappearing path — user
- [settled] Pruning rule: a pin/collapse entry is dropped when its directory no longer exists on disk (covers removed worktrees, deleted folders, missing worktrees); a folder emptied of conversations keeps its entry, and starting a conversation there uncollapses it anyway — agent's call, delegated by user
- [settled] Collapsed header shows a running spinner and an input mark aggregated from its rows; no conversation count (out of scope) — user
- [settled] Collapsed headers also show finished/failed marks — user
- [settled] The same aggregated marks apply to collapsed worktree headers — extension of the above, flagged to user

## Persistence
- [settled] Pin and collapse state persist on the server, shared across devices — user
- [settled] Pin/collapse changes propagate live to every open client; it's all server-side state — user
- [settled] Pins and collapse apply only to the sidebar (desktop and phone sheet); Home, /sessions, picker get only the new ordering — user

## Pins
- [settled] Only repos are pinnable for now; plain folders aren't — user
- [settled] A pinned repo with no conversations still shows (header + new-conversation button) — user
- [settled] Pinned repos sit on top, alphabetical; unpinned groups below by last prompt — user
- [settled] Pinned repos sort by their displayed label (collision prefix included), case-insensitive, numeric-aware — agent's call, delegated by user
- [settled] Pin affordance must behave the same on every client type (no hover/touch branching) — user
- [settled] Pin affordance: always-visible pin icon on every repo header, before the new-worktree icon; outline when unpinned, filled when pinned — user accepted agent's proposal

## Main checkout
- [settled] In the sidebar, a layout repo always shows its main checkout sub-group, even empty, so its `+` can start a conversation there; other surfaces unchanged — user
- [settled] That includes pinned repos with no conversations; the server sends each pinned repo's main checkout with the sidebar state — user
- [settled] The repo header keeps its `+` for the container folder — agent's call, accepted by user
- [settled] Not added to search results, like empty pinned repos — agent's call, accepted by user
