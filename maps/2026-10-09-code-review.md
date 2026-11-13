<!-- pi:map -->
# pi-code — Code review and line references: decision map

Revisits the deferred "tree/diff as side panes" item of [2026-09-30-desktop.md](2026-09-30-desktop.md).

## Scope & context
- [settled] Goal: review git diffs and send line references from them into the composer, like Cursor's Agents Window "Changes" — user
- [settled] Build on the existing `/agents/$id/diff` screen rather than starting over — user
- [settled] Diff base is a toggle: uncommitted work vs HEAD, or vs a selectable base branch — user
- [settled] Platforms: desktop and mobile — user
- [settled] Codebase explorer with fuzzy file search is in scope — user
- [settled] Desktop: diff and explorer sit in a pane next to the conversation, not a full page — user; resolves the backlog item
- [settled] Server gains branch listing, default-branch detection and merge-base as needed (F4) — user
- [settled] Branch mode diffs against the merge-base with the base branch (what this branch changed, PR-style) — user
- [settled] Branch mode has an "include uncommitted work" toggle, off by default — user
- [settled] Base branch: picker over local branches, defaulting to the detected default branch — user
- [settled] Desktop selection: click selects one line, drag across line numbers selects a range; no shift-click (library lacks it) — user
- [settled] Mobile selection: tap a line, then tap another to extend to a range — user
- [settled] A reference is a chip in the composer (like file attachments) carrying path and line range — user
- [settled] Desktop: finishing a click or drag inserts the chip immediately and focuses the composer — user
- [settled] Mobile: after the second tap, an "Add to chat" bar inserts one reference and returns to the conversation; one reference per trip — user
- [settled] Lines absent from the working tree (deleted lines, F2; HEAD side with uncommitted off, F6) are referenced with the version named (e.g. `path:40-45 @ <sha>`) — user
- [settled] Name the version only when needed: deleted lines, or a file whose working-tree copy differs from the shown side — user
- [settled] References go inline at the cursor as blue text in the composer (no chip strip) and stay blue in the sent message — user; supersedes the chip-strip reading of the chip decision
- [settled] Inline technique: highlight overlay behind a native textarea; whole-reference delete handled in code (F10) — user
- [settled] Reference syntax: `@path:42` / `@path:40-45`; version-named `@<short-sha>:path:40-45` (git's own `rev:path`, so `git show <sha>:path` works); paths with whitespace quoted `@"my dir/a.ts":40-45` as in pi's TUI — assistant's call (delegated): matches pi's `@path` convention, line suffix required so `@scope/pkg`, emails and `@someone` aren't matched
- [settled] A reference starts at line start or after whitespace; the version is always a commit sha, never a moving ref like HEAD — assistant's call (delegated): stable after the agent commits
- [settled] One shared module (protocol package) formats and parses references, used by the composer overlay, whole-reference delete and transcript coloring — assistant's call (delegated): single source of truth for the syntax
- [settled] Explorer is a fuzzy file-search palette only; no folder tree for now — user
- [settled] Opening a file from the explorer shows it syntax-highlighted with the same line selection as the diff — user
- [settled] Composer draft persists per conversation across navigation (F9) — user
- [settled] Server gains a file listing/reading API scoped to the agent cwd (F5) — user
- [settled] Desktop pane opens/closes from a header button and `/diff`; conversation and pane split the width in halves; no resizing yet — user
- [settled] Desktop: conversation plus one side pane with "Changes" and "Files" tabs — user
- [settled] Diff refreshes automatically while open — user
- [settled] Diff refreshes after each agent turn (pi `turn_end`), riding the server's existing post-turn git status refresh (F13) — user
- [settled] No explorer outside git repos; the file list comes from git (`ls-files`, tracked + untracked non-ignored) — user
- [settled] Line selection also works in the transcript's edit/write tool diffs — user
- [settled] Transcript-diff references are inserted as-is; they may be stale after later edits (F14) — user: accepted limitation
- [settled] Mobile: the explorer is reached only via a "Files" tab on the diff page (mirrors the desktop pane's tabs) — user
- [settled] Desktop pane open/closed state is per conversation and survives a reload — user
- [settled] File viewer reuses the diff's limits (1 MB → too large, binary flagged, "Show anyway" past 1500 lines / 400k chars) — user
- [settled] Fuzzy search runs on the server: debounced query → top 10 paths, from `git ls-files` — user
- [settled] Fuzzy scorer is a small dependency, star count weighed heavily — user
- [settled] Library: fuzzysort, with our own basename boost (F16) — user
- [settled] Clicking a blue reference in a sent message opens the Files tab (pane on desktop, page on mobile) at those lines, highlighted — user
- [settled] Clicking a version-named reference opens the current file, with a toast that the reference points at a different version — user
- [settled] References in the agent's replies are colored and clickable too — user
- [settled] In agent replies only the `@` syntax counts; bare `path:N` is not linked (F17) — user
- [settled] References inside inline code count too, in user and agent messages — user
- [settled] Nudge the model to write `@path:N` via a system-prompt guideline injected by pi-code itself, not the user's global APPEND_SYSTEM.md — user
- [settled] The guideline is injected by this repo's pi-code extension (`before_agent_start`), wording: "When you point to specific lines of code, write the reference as `@path:N` for one line or `@path:N-M` for a range, with the path relative to the working directory. Quote paths that contain spaces: `@"dir name/file.ts":N`. The user can click these references to open those lines." — user: keeps the user's APPEND_SYSTEM.md intact (F20)
- [settled] Below the 1024px desktop breakpoint the mobile flow applies (full pages) — user, on assistant's recommendation: matches the rest of the app; halves under 512px are too cramped
- [settled] Bump the extension's pinned pi types to 1.x (matching the installed 1.1.0) and push the guideline onto `event.systemPromptOptions.promptGuidelines` in `before_agent_start` (verified in 1.1.0's types) — user

## Findings
- [settled] F1: a full-page diff route exists (working tree vs HEAD incl. untracked, `@git-diff-view/react`); navigating to it unmounts the composer and loses typed text; the draft store only replaces composer text — acknowledged
- [settled] F2: deleted lines have no line number in the current file, so `path:N` can't point at them — acknowledged
- [settled] F3: `@git-diff-view/react` 0.1.7 (latest) ships `DiffViewWithMultiSelect`: drag across line numbers → `{side, start, end, lines[].value}`; one side only; mouse events only (no shift-click, no touch); "+" widget only on changed rows — acknowledged
- [settled] F4: the server has no branch listing, default-branch detection or merge-base; worktree creation defaults inline to origin/main → origin/master; `gitDiff` hard-codes HEAD — acknowledged
- [settled] F5: no file listing/reading endpoint scoped to the agent cwd (`git ls-files` can list); composer has slash-command autocomplete only, no @-mentions; `cmdk` (fuzzy scorer) already a dependency; the diff library can render a whole file via a synthetic all-context hunk — acknowledged
- [settled] F6: line numbers in a diff belong to the versions being compared. With uncommitted off in branch mode, the new side is HEAD, so its numbers can differ from the file on disk that the agent reads; the old side is always the base (HEAD or merge-base) — acknowledged
- [settled] F7: attachment chips sit in a strip above the plain `<textarea>` and are appended to the message on send; a textarea can't color text or hold inline chips, so inline blue references need a highlight overlay behind it or a contenteditable editor — acknowledged
- [settled] F8: an overlay keeps the native textarea (reliable on mobile: autocorrect, IME, caret) but a reference is ordinary text — editing one char breaks it back into plain text; contenteditable gives atomic tokens deleted as a unit, at the cost of known mobile quirks and more code — acknowledged
- [settled] F9: the mobile flow needs the composer text to survive going to the diff and back (F1: today it's lost), so draft persistence per conversation becomes a requirement — acknowledged
- [settled] F10: contenteditable mentions on Android/Gboard: hand-rolled is high severity (non-cancelable deletes, keyboard dismissing on atoms, caret jumps); Lexical/Tiptap medium (open Android mention-delete bugs, composition regressions through 2025, +35–120 kB gz); textarea+overlay low-medium (layout sync work, atomicity hand-rolled, native IME untouched) — acknowledged
- [settled] F11: pi sends RPC prompt text to the model verbatim, `@path` included (no expansion); the pi TUI's @-autocomplete inserts `@src/foo.ts`, quoting paths with spaces as `@"my dir/a.ts"` — acknowledged
- [settled] F12: the web client already receives each `tool_execution_end` and `agent_settled` on the per-agent stream; nothing watches the working tree, so edits from outside the agent (your editor, a TUI pi) trigger nothing unless a filesystem watcher is added — acknowledged
- [settled] F13: a pi turn is one model response plus its tool calls (a run has many); the server already re-reads git status 2 s after each `turn_end` and pushes a `git_status` event, so the diff can refetch on that — acknowledged
- [settled] F14: transcript edit diffs come from pi's `details.patch`, a unified patch with real line numbers for the file right after that edit; later edits can shift them, and no commit names that version (write results show as all-added) — acknowledged
- [settled] F15: server-side search isn't a new pattern: the project picker already does a debounced (250 ms) server autocomplete capped at 50 results (`/api/fs/dirs`). It needs a fuzzy scorer on the server (none today; small dependency or hand-written). Client-side, `cmdk` renders every item, so a large list needs its own filtering/virtualization — acknowledged
- [settled] F16: fuse.js (20.5k★) is approximate/typo matching, poor at path abbreviations and slowest (~100 ms+/query at 50k); fuzzysort (4.4k★, 0 deps, ESM+types, maintained Aug 2026) is subsequence matching built for file lists (<1 ms for 13k files claimed), no built-in basename boost; fzf-for-js fits best but 957★ and stale since 2023 — acknowledged
- [settled] F17: models usually write file references without `@` (`src/foo.ts:42`, often in backticks), so matching only `@path:N` in replies would catch few; a bare `path:N` pattern risks false hits (`localhost:4180`, `10:30`) unless it requires a `/` or a file extension — acknowledged
- [settled] F18: the diff viewer switches to side-by-side only when its own width is ≥1024px; a half-width pane next to a 280px sidebar stays below that on most screens, so the pane will usually show unified diffs — acknowledged
- [settled] F19: the pi-code extension lives in this repo (`packages/pi-extension`, loaded only by pi-code via `--extension`); its `before_agent_start` hook can add prompt guidelines — acknowledged
- [settled] F20: passing `--append-system-prompt` makes pi skip discovering APPEND_SYSTEM.md (global and project), silently dropping the user's own instructions (`resource-loader.js:476-480`); the extension's `before_agent_start` adds a guideline without touching them, and pi-code always loads the extension — acknowledged
- [settled] F21: the extension's pi types are pinned to 0.87.1 (`devDependencies`), whose `before_agent_start` can only replace the whole system prompt; the installed pi is 1.1.0, whose docs prefer changing structured prompt sections/guidelines — acknowledged
