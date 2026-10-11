# Plan — code review and line references

Spans `packages/protocol`, `packages/server`, `packages/pi-extension`, `packages/web`. Design: `design/07-code-review.md`; decisions: `maps/2026-10-09-code-review.md`. The protocol types and the reference module (C1) come first, then the server endpoints (C2–C4) and the extension (C5). The web client follows in dependency order: the draft store and composer (C6–C7), the diff viewer's selection API (C8), selectable diffs (C9), the review panel tabs (C10–C11), their desktop and phone hosts (C12), and clickable references (C13). The docs update goes last (C14).

Every task reads the design for exact behavior. Each task's "Done when" includes `pnpm check` and `pnpm test` passing.

## Test strategy

- **Protocol:** table-driven unit tests for `code-refs.ts`.
- **Git:** temp dirs with real `git`, as in `git/git.test.ts`: commits on `main`, a feature branch with commits, uncommitted and untracked changes, an ignored file, a nested repo, a subfolder cwd. A bare repo as `origin`, cloned, covers `origin/HEAD`.
- **Server routes:** integration tests through `testing/http-harness.ts`, with the repo created as `harness.project`, agents on the fake pi and `harness.stream()` for `git_status` events.
- **Extension:** unit tests with the fake `pi` of `index.test.ts`.
- **Web:** unit tests for stores and pure helpers; component tests with `lib/api.ts` or `fetch` stubbed (`stubFetch`), `stubMatchMedia` for desktop vs phone, and `stubCanvas` / `loadedDiff` for diff rendering. Line selection is driven by `mousedown` / `mouseover` / `mouseup` events on `[data-line-new-num]` / `[data-line-old-num]` spans.

## Protocol

### C1 — Types, error code and reference module
- `packages/protocol/src/types.ts`: `GitFileDiff.worktreeChanged?: true`; `GitDiffResponse.oldRev?` and `newRev?`; `GitBranchesResponse`, `FileSearchResponse`, `FileContentResponse`.
- `packages/protocol/src/errors.ts`: `file_not_found` (404).
- `packages/protocol/src/code-refs.ts` (exported from `index.ts`): `CodeRef`, `CodeRefMatch`, `formatCodeRef`, `findCodeRefs`, per the design's Syntax. That covers the optional rev, quoted and bare paths (a bare path may contain `:` but no `:N` segment followed by an end), the start rule (text start, whitespace, backtick), the end rule, `M > N`, quoting of whitespace and rev-like paths, `./` before a versioned path, and `null` for unwritable paths.
- Done when: `code-refs.test.ts` covers every example and non-example in the design. It also covers `@a:b.ts:4` (path `a:b.ts`), `@abc1234:4` (path, not rev), `@abc1234:src/a.ts:4` (rev), `@HEAD:a.ts:3` (path `HEAD:a.ts`), `@src/a.ts:12:5` (path `src/a.ts`, line 12), `formatCodeRef` with a rev writing `@<rev>:./src/a.ts:4` and leaving `../x.ts` as is, `` `@a.ts:3` `` inside backticks, trailing `.`, `,` and `)`, `@a.ts:12-` and `@a.ts:5-3` (no match), two references in one line, offsets with non-ASCII text before a reference, and `formatCodeRef` round trips through `findCodeRefs`.

## Server

### C2 — Diff modes, cwd scoping and the refresh signal
- `git/git.ts`: `gitDiff(cwd, { base?, uncommitted? }) → GitDiffResponse`. Every git command runs in the cwd, with `--relative` on tracked diffs, untracked files listed in the cwd and blob lookups as `<rev>:./<path>`. Without `base`: today's mode, plus `oldRev` (short HEAD, absent without commits). With `base`: the design's validation (`show-ref --verify`), then the merge-base, and either working tree + untracked (`uncommitted`) or `<merge-base>..HEAD`, with blob-based size checks (merge-base blobs for deleted files), `worktreeChanged` from `git diff --name-only -z --relative HEAD`, and `newRev`. `trackedDiffs` takes an optional `to` rev.
- `http/review-routes.ts` (new, mounted at `/api/agents` in `app.ts` beside `agentsRoutes`): `GET /:id/git/diff` parses `base` and `uncommitted=1`; the route moves out of `agents-routes.ts`.
- `agents/pipeline.ts`: `refreshGitStatus` publishes `git_status` after every scheduled refresh, changed or not; the startup read keeps publishing only on change.
- Done when: `git.test.ts` covers uncommitted mode as before (existing tests updated to the response shape) with `oldRev`. It covers branch mode with uncommitted off (only committed changes, no untracked, `newRev`, `worktreeChanged` on a file edited after commit and absent on others), branch mode with uncommitted on (committed + uncommitted + untracked against the merge-base), base equal to the current branch (empty), unknown base, a base expression such as `main~1` (rejected), base starting with `-`, no commits, unrelated histories, a cwd in a subfolder (paths cwd-relative, changes outside left out) and a large file in branch mode (`tooLarge`), and a large file deleted since the merge-base (`tooLarge`). Harness tests: `GET /git/diff?base=main&uncommitted=1` and a `400` for an unknown base. A harness test sees a second `git_status` event with an unchanged status after a second prompt (`gitDebounceMs` short).

### C3 — Branches
- `git/refs.ts` (new): `listBranches(cwd) → GitBranchesResponse` per the design (most recent first, `refname:lstrip=2`, default detection through `origin/HEAD`, then `main`, then `master`).
- `http/review-routes.ts`: `GET /:id/git/branches`.
- Done when: `git/refs.test.ts` covers the ordering, `origin/HEAD` → `trunk` when local `trunk` exists, `origin/HEAD` naming a branch missing locally (falls back to `main`), `master` only, none (`null`), and a tag named like a branch (the branch still listed as `x`). A harness test covers the route and `404 not_a_git_repo`.

### C4 — File search and file read
- `packages/server/package.json`: `fuzzysort` `^4`.
- `git/files.ts` (new): `listProjectFiles(cwd)` (`ls-files --cached --others --exclude-standard -z`, deduplicated, nested repos dropped); `searchFiles(cwd, q)` with the design's keys, `scoreFn`, `threshold: 0` and `limit: 10`, empty `q` → `[]`, over 200 characters → `invalid_body`; `readProjectFile(cwd, path)` with realpath confinement to the cwd, `file_not_found`, 1 MB `tooLarge` (`MAX_PATCH_BYTES`), NUL-in-8000-bytes `binary`, UTF-8 content, normalized cwd-relative `path`.
- `http/review-routes.ts`: `GET /:id/files?q=` and `GET /:id/files/content?path=`, both `404 not_a_git_repo` outside a work tree.
- Done when: `git/files.test.ts` covers tracked and untracked files listed, ignored files and a nested repo left out, a subfolder cwd listing only its subtree, ranking (`git.ts` query ranks `src/git/git.ts` above `src/agents/git-helper-test.ts`; a weak basename match outranks a strong cross-directory one), the limit of 10, empty and too-long `q`, and a read of text, an empty file, binary, over 1 MB, a missing file, a directory, `../x`, a symlink leading out of the cwd and an absolute path inside the cwd. Harness tests cover both routes, `file_not_found` and `not_a_git_repo`.

## Extension

### C5 — Reference guideline
- `packages/pi-extension/package.json`: `@earendil-works/pi-coding-agent` `1.1.0` (dev dependency); `pnpm install` updates the lockfile. Type errors from the bump in `index.ts` and `index.test.ts` are fixed (the trust context shape, command options).
- `packages/pi-extension/src/index.ts`: export `REFERENCE_GUIDELINE` with the map's exact wording; a `before_agent_start` handler pushes it onto `event.systemPromptOptions.promptGuidelines`, or appends it to `appendSystemPrompt` when `customPrompt` is set, unless already present, and returns nothing.
- Done when: `index.test.ts` loads the extension, runs the handler on an event with empty and pre-filled `promptGuidelines`, and sees exactly one copy of the guideline appended and no return value. With `customPrompt` set, the guideline is appended once to `appendSystemPrompt`, after its existing text. Manual: in a pi-code conversation, asking "where is X defined?" gets a reply using `@path:N`. The TUI's `APPEND_SYSTEM.md` instructions still apply in that conversation.

## Web

### C6 — Draft store
- `features/conversation/attachments.ts` (new): `Attachment`, `prepareAttachment`, moved from `composer.tsx`.
- `store/drafts.ts` (new): `useDrafts` per the design (`edit`, `setAttachments`, `replace`, `insertReference` with its spacing rules, `clear`, `external`).
- `composer.tsx`: text, selection and attachments come from the draft of the route's agent. The textarea writes `edit` on input and select. A changed `external` (on update, or since the last mount) focuses the textarea and applies the stored selection. `set_editor_text` and Stop & edit use `replace`. Sending calls `clear` before the request; a failure restores the text and attachments only into a still-empty draft, as today.
- `features/conversation/conversation-ui.ts`: `draft`, `setDraft`, `takeDraft` removed; `session-actions.ts` (fork) and `share-screen.tsx` call `useDrafts.getState().replace`.
- Done when: `drafts.test.ts` covers `insertReference` at the start, mid-word, after a space, before text, replacing a selection, and the caret after insertion. Component tests: text and attachments survive unmounting and remounting the composer (navigating to the tree screen and back), each conversation keeps its own draft, the fork and share drafts arrive, a reference inserted while the composer is mounted lands at the caret and focuses it, and a reference inserted while it is unmounted lands at the saved caret, with the caret after it and the textarea focused, once it remounts. Text typed while a send is in flight survives a failed send. The existing composer tests pass.

### C7 — Composer overlay and whole-reference delete
- `features/conversation/composer-input.tsx` (new): the textarea + mirror per the design (shared classes, blue spans from `findCodeRefs`, trailing zero-width space, scroll sync, transparent text with a visible caret and selection), and the shared `text-base md:text-sm` and `scrollbar-gutter: stable`, and the whole-reference delete in `onChange` (removed range from the pre-edit selection, prefix/suffix as fallback; pure deletions overlapping a reference without covering it remove it whole, caret at its start; no rewrite while composing, re-checked on `compositionend`). `composer.tsx` renders it in place of the bare textarea, keeping the slash-menu ARIA wiring, `onKeyDown` and autosize.
- Done when: component tests show references as blue spans in the mirror (quoted and version-named ones included, `@scope/pkg` not), the mirror text equal to the textarea value after each edit, and Backspace at the end of a reference, a deletion inside one and a cut overlapping one each removing it whole. A deletion covering a reference and more removes exactly that range; typing inside a reference leaves the text edited and unhighlighted. Deleting a selected `@ ` from `x @ @a.ts:3` leaves the reference intact. A deletion during composition leaves the value untouched until `compositionend`. Slash autocomplete and key handling tests still pass. Manual: on Android with Gboard, Backspace at the end of a reference removes it whole with no duplicated or lost letters, and in a draft long enough to scroll the textarea the blue spans stay aligned with the text.

### C8 — Diff viewer selection API
- `components/diff`: `DiffViewer` gains `onSelectLines`, `selection`, `scrollTo` and `unified` per the design. `diff-view-impl.tsx` memoizes `data` on the parsed patch and renders `DiffViewWithMultiSelect`, keyed on it and with a ref, when `onSelectLines` is set (else `DiffView`). It applies `selection` (`setPreselectedLines`, or `clearSelection` plus empty preselected lines for `null`) and `scrollTo` in an effect on mount and on each change, once the rows exist (`requestAnimationFrame`, at most 60 frames). `parse-patch.ts`: `fileAsPatch(path, content)`.
- Done when: `parse-patch.test.ts` covers `fileAsPatch` (line count, no trailing-newline file, empty content). `diff-viewer.test.tsx` covers a click and a drag reporting `onSelectLines` (new and old side), a click still reported after a re-render with a new callback, a theme change and a re-render with the same patch, a click on the new rows after the patch changes, a `selection` set after a click marking the given range rather than the clicked line, `selection: null` clearing the mark, and `scrollTo` scrolling its row into view on first load and after "Show anyway" on a large patch.

### C9 — Selectable diffs
- `features/review/line-selection.ts` (new): the phone's single pending selection (owner key, side, anchor, end).
- `features/review/selectable-diff.tsx` (new): `SelectableDiff` (`toReference`, `onAdded`, `highlight`), with the agent id and cwd from the conversation store: on desktop, insert on selection complete; on phone, the tap-tap flow with `AddToChatBar` (portalled, fixed at the bottom), a multi-line completion taken as the range, other owners' selections cleared, its own cleared on a new patch; the pending selection or `highlight` passed as `selection`, `highlight` as `scrollTo`; a toast when `formatCodeRef` returns `null`. A helper `cwdRelative(path, cwd)` (`lib/paths.ts`).
- `tools/file-edits.tsx`: edit and write bodies render `SelectableDiff` with the tool path made relative to `agent.cwd`.
- Done when: component tests on desktop: a mousedown/mouseup on a new-side number inserts `@notes.txt:2`, a drag inserts a range, and the composer is focused. On phone: one tap shows "Tap the last line", a second tap shows the range bar and marks the range from the first tap, Add to chat inserts and calls `onAdded`, Cancel clears the bar and the mark, a tap on the other side restarts, a drag gives the range bar directly, a tap in a second diff clears the first, a new patch clears the pending selection, and selecting still works after a re-render. An absolute tool path inside the cwd is inserted cwd-relative. Existing tool renderer tests pass.

### C10 — Review state and Changes tab
- `lib/api.ts`: `getGitDiff(id, { base?, uncommitted? }) → GitDiffResponse`, `getGitBranches(id)`, `searchFiles(id, q)`, `getFileContent(id, path)`. `lib/query-client.ts`: `queryKeys.gitDiff`, `gitBranches` (`["agent", id, "branches"]`, outside the review prefix), `fileSearch`, `fileContent`, `review(agentId)` per the design.
- `features/review/review-state.ts` (new): `useReview` store with `openPane`, `togglePane`, `setTab`, `setDiffMode`, `openFile`, `setFilesQuery`; only open panes persisted (`pi-code:review`).
- `features/review/changes-view.tsx` (new): `FileRow` and `Totals` moved from `diff-screen.tsx`; the mode bar (Uncommitted / Branch, base `<select>` from `getGitBranches` defaulting to `defaultBranch`, Include uncommitted); `SelectableDiff` per file with `toReference` per the design's Version naming table.
- `features/diff/diff-screen.tsx`: renders `ChangesView` in place of its own file list, keeping its page shell, so it builds on the new `getGitDiff` until C12.
- `store/live-registry.ts`: an applied `git_status` event, and a store hydrated after a snapshot refetch, invalidate `queryKeys.review(agentId)`.
- Done when: unit tests cover the review store's defaults and that only `paneOpen` survives a reload (closed panes leave no entry). Component tests cover switching modes (request query strings), the default base and a chosen base, the branch-mode empty state, an unknown-base error with the picker usable, and references from each table row: old side `@<oldRev>:./<oldPath>:N`, HEAD side with and without `worktreeChanged`, working-tree side unversioned. Registry tests check that a `git_status` event and a refetch's hydration invalidate the review queries. `diff-screen.test.tsx` passes, updated to the response shape.

### C11 — Files tab
- `features/review/files-view.tsx` (new): cmdk search (`shouldFilter={false}`, 250 ms debounce, top 10, basename-first rows, "Type to search files"), query kept in the review state; picking a file calls `openFile`.
- `features/review/file-viewer.tsx` (new): header with path and back to search; `getFileContent`; `SelectableDiff` with `unified`, `fileAsPatch` and the text as `content` (a new `DiffViewer` prop passed to the library for both sides), the old-number column hidden; `closeFile` in the review state for going back; `highlight` from `target`; messages for binary, too large, empty, `file_not_found`, `not_a_git_repo`; the past-the-end toast.
- Done when: component tests cover a debounced search (one request after typing), keyboard picking, opening and going back with the query kept, a reference `@src/a.ts:3-4` from the viewer, a target highlighted and scrolled to, a target past the end (toast, no highlight), each message, and the "Show anyway" guard on a 2000-line file with a target highlighted after "Show anyway".

### C12 — Desktop pane and phone page
- `features/review/review-panel.tsx` (new): tabs, Refresh (refetches the active tab's queries), the active view; `not_a_git_repo` message.
- `features/review/review-pane.tsx` (new) and `conversation-screen.tsx`: at ≥1024px with `paneOpen`, a 50/50 row with the pane (tabs, Refresh, ×) and `lg:px-6` instead of `lg:px-32` on the conversation's header, transcript and composer columns.
- `header.tsx`: on desktop, the "Show changes" / "Hide changes" toggle (`aria-pressed`) and no Diff menu item; on phone, the Diff menu item as today. `use-builtin-commands.ts`: `/diff` toggles the pane on desktop and navigates on phone.
- `features/diff/diff-screen.tsx`: the phone page (back chevron, `ReviewPanel`); on desktop it opens the pane and replaces itself with `/agents/$agentId`. Its `SelectableDiff`s pass `onAdded` navigating to the conversation.
- Done when: component tests on desktop cover the header button and `/diff` toggling the pane, the state surviving a remount from persisted storage, the pane absent on the tree route, `/diff` URL redirecting with the pane open, and a click selection in the pane landing in the composer. On phone (<1024px, `paneOpen` true): no pane, the header menu's Diff opening the page, the Files tab on the page, and Add to chat returning to the conversation with the reference in the draft. `diff-screen.test.tsx` is updated.

### C13 — Clickable references in messages
- `features/review/code-ref-text.tsx` (new): `CodeRefText` (plain text split by `findCodeRefs`, blue buttons). `transcript/user-message.tsx` renders the body through it.
- `lib/code-refs-rehype.ts` (new): `rehypeCodeRefs`, skipping `pre` and `a`, splitting text nodes, inline `code` included, into `span[data-code-ref]` (blue, `role="button"`, `tabIndex=0`). `components/markdown.tsx`: `codeRefs` prop appending the plugin after `harden`. `assistant-message.tsx` sets it on text blocks and handles click and Enter on `[data-code-ref]` by delegation.
- `features/review/open-reference.ts` (new): `useOpenReference` per the design (Files tab and target; pane on desktop, navigation on phone; toast for version-named references).
- Done when: unit tests cover the plugin on paragraphs, inline code, emphasis, links and code blocks (the last two untouched). Component tests cover blue references in user messages (inline code included) and assistant text. Clicking one opens the pane's Files tab at those lines on desktop and navigates to the page with the target on phone; a version-named one also shows the toast; bare `src/a.ts:3` in a reply stays plain.

## Docs

### C14 — Update the docs, README and backlog
- `docs/design/00-overview.md`: `07-code-review.md` in the document table; the extension's responsibilities include the reference guideline.
- `docs/design/01-server.md` (Git): the diff modes, cwd scoping, branches, file search and read, `git_status` after every post-turn refresh.
- `docs/design/02-api-contract.md`: the diff query and response fields, `GET git/branches`, `GET files`, `GET files/content`, `file_not_found`, the `git_status` refresh note.
- `docs/design/03-web-client.md`: routes table (`/agents/$agentId/diff` as the review page), Diffs and Diff screen sections pointing to `07`, composer (draft store, inline references), transcript rendering (clickable references), the `/diff` command.
- `docs/design/04-pi-extension.md`: a third section, the reference guideline, and the 1.x types.
- `docs/design/05-desktop.md` (Shell and routes, Layout): the review pane beside the conversation.
- `docs/plan/00-overview.md`: `07-code-review.md` with prefix `C` in the component table and a phase row.
- `README.md`: `07` in the documentation list; the design's main limitations (no working-tree watcher, stale transcript references, subfolder scoping) in Known limitations; the desktop paragraph mentions the review pane.
- `BACKLOG.md`: "Tree and diff as side panes next to the conversation instead of full pages" removed.
- Done when: the docs mention the new routes, `file_not_found`, the reference syntax and the guideline, and link `07-code-review.md`.

## End-to-end verification

On the Mac over the tailnet URL and on the Android phone, with a conversation in a repo on a feature branch that has commits ahead of `main`, plus uncommitted edits and an untracked file:

1. Desktop: the header button opens the pane at half width; Changes lists the uncommitted edits and the untracked file. Reload: the pane is still open for this conversation and closed for another.
2. Switch to Branch: base `main` is preselected and only committed changes show. Turn on Include uncommitted: the edits and the untracked file join.
3. Click a new-side line number with uncommitted off on a file also edited locally: the composer gets `@<sha>:./path:N` and focus. Drag across deleted lines: `@<merge-base sha>:./path:N-M`. In uncommitted mode, a new-side drag gives `@path:N-M` in blue.
4. Backspace at the end of a reference removes it whole; typing inside one turns it plain.
5. Files: type `gitts`; `git.ts` files rank first. Open one, select lines, send the message: the sent message shows the reference in blue. Click it: the Files tab opens at those lines, highlighted.
6. Ask the agent to edit a file and point to the change: after the turn, the Changes tab refreshes on its own. The reply uses `@path:N`, the reference is blue (also inside inline code) and opens the file at that line.
7. Click a version-named reference: the current file opens with the version toast.
8. Expand an edit tool call in the transcript and click a line: the reference is inserted.
9. Phone: type a draft, open Diff from the header menu, tap two line numbers, tap Add to chat: the conversation shows the draft with the reference at the caret. Repeat from the Files tab. Tap-tap in a transcript edit diff shows the bar too.
10. Narrow the desktop window below 1024px: the pane disappears and the header menu's Diff opens the page.
11. A conversation in a non-git folder: both tabs say it isn't a git repository.
