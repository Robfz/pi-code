<!-- pi:map -->
# pi-code — Delete sessions: decision map

Builds on [2026-09-26-origin.md](2026-09-26-origin.md), [2026-09-30-desktop.md](2026-09-30-desktop.md) and [2026-09-30-worktrees.md](2026-09-30-worktrees.md).

## Scope & context
- [settled] Goal: less clutter in the listings and less disk space used — user
- [settled] Granularity: one session at a time; no bulk cleanup — user
- [settled] Deletable: session rows, exited-agent rows and live-agent rows; deleting an agent's session closes the agent — user
- [settled] F1: pi has no delete primitive (no RPC/SDK command on 1.1.0 or upstream main; upstream rejected `delete_session` in PR #1522). pi-code deletes the `.jsonl` itself. That is a second exception to the read-only agent dir rule, after worktree removal — acknowledged
- [settled] F2: a session gets its own row only when no agent (live or exited) holds it; otherwise it shows as the agent's row. A running pi recreates a deleted file, so agents must be closed first; an exited agent whose file is gone can't restart — acknowledged
- [settled] Exited agent = an agent whose pi died unexpectedly; the server keeps it listed (no mark) until reopened (restarts pi into its session), closed, or swept idle after 7 days — explained to user
- [settled] F3: no listing has per-row actions on session or exited-agent rows (only `×` close on live sidebar rows). Session rows appear in the sidebar (desktop, and the same component in the mobile sheet), Home "Recent sessions", `/sessions` and the share screen. The sidebar shows the 7-day window plus agents; only `/sessions` lists all ages. The conversation header has a `⋮` menu that includes Close — acknowledged
- [settled] F4: forks and clones are self-contained copies. Their header's `parentSession` is only a lineage path, which pi-code's UI ignores. Deleting a parent loses nothing in its children — acknowledged
- [settled] F5: "Trash" = the macOS Trash of the server's user, via `/usr/bin/trash` (present on this Mac). Recoverable only on that machine (Finder → Put Back), not from the web UI. Disk space is freed only when the Trash is emptied. Where `trash` is missing (e.g. Linux without trash-cli), the fallback `unlink` is permanent — acknowledged

## Surfaces & UX
- [settled] Delete offered on sidebar rows, Home "Recent sessions" rows, `/sessions` rows and the conversation header `⋮` menu; not the share screen — user
- [settled] No confirmation, for any row — user, kept after the challenge (phone mis-tap, live agent killed mid-turn); recovery is the server's Trash
- [settled] F6: nothing in the web client is hover-only; the live rows' `×` is always visible. Rows in a missing worktree are disabled except live agents, so their sessions are only cleanable via "Remove worktree" — acknowledged
- [settled] "Close" is retired as a user-facing action; the only row actions are Stop (today's close: stop pi, keep the conversation listed) and Delete — user, after the "Archive" challenge
- [settled] Live-agent row: `×` opens a modal offering Stop or Delete (subsumes today's streaming/awaiting-input close confirmation) — user
- [settled] Exited-agent row: `×` deletes — user
- [settled] Plain session row: `×` deletes, like exited rows; the modal appears only when there is a choice (live) — user, accepting suggestion
- [settled] Home and `/sessions` rows get a `×` — user
- [settled] Home and `/sessions` rows of sessions held by an agent ("Open" badge): `×` follows the holding agent's rule (live → modal, exited → delete) — user
- [settled] Conversation header `⋮`: "Close" becomes Stop, and Delete is added (lands on Home) — user
- [settled] Sessions and exited agents in a missing worktree are deletable one by one — user
- [settled] Deleting the conversation currently open lands on Home — user
- [settled] F7: an agent row stands for its current session only; files it left via fork/new/switch are separate plain rows, so Delete on an agent row removes only its current file — acknowledged
- [settled] F8: pi writes no session file before the first message, so Delete on a brand-new live conversation only stops it — acknowledged
- [settled] No success feedback; the row disappearing is enough — user
- [settled] Failures show an error toast: a file that could be neither trashed nor unlinked, and the F9 case (agent stopped, file kept) — user

## Deletion semantics
- [settled] `trash` first, `unlink` as fallback, like worktree removal and pi's TUI (reuse `deleteSessionFiles`) — user, accepting F5
- [settled] Least privilege: the server deletes only files the catalog lists (`<agentDir>/sessions/<dir>/*.jsonl` with a session header), never arbitrary `.jsonl` under `$HOME` — user delegated "all features, fewest privileges"
- [settled] F9: an agent can run a session opened from outside the agent dir (opening accepts any `.jsonl` under `$HOME`); Delete can stop such an agent but won't delete its file — acknowledged
