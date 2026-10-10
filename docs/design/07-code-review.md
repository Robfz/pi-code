# Code review and line references

Review the project's git changes and files next to a conversation, and send line references from them into the composer. References are inline `@path:N` text that pi passes to the model verbatim; pi-code colors them blue and makes them clickable wherever they appear. Decisions and rationale: [`../../maps/2026-10-09-code-review.md`](../../maps/2026-10-09-code-review.md). Where this document overlaps `01`–`06`, it takes precedence.

Terms:

- **Changes**: the git diff of the agent's project in one of two modes (below). It replaces the full-page diff of `03`.
- **Files**: a fuzzy file search over the project and a file viewer.
- **Review panel**: the Changes and Files tabs. On desktop it is a pane beside the conversation; on phones it is the `/agents/$agentId/diff` page.
- **Reference**: `@path:N` or `@path:N-M` text, optionally naming a commit (`@<sha>:./path:N-M`).

All paths in this feature are relative to the agent's cwd, which is what the model reads and writes. Every git command runs in the cwd, so a conversation in a subfolder of a repo sees only that subtree.

## Diff modes

| Mode | Old side | New side | Untracked files |
|---|---|---|---|
| Uncommitted (default) | `HEAD` (the empty tree without commits) | working tree | included |
| Branch, uncommitted off (the toggle's default) | `merge-base(<base>, HEAD)` | `HEAD` | not included |
| Branch, uncommitted on | `merge-base(<base>, HEAD)` | working tree | included |

- Branch mode shows what the current branch changed since it left `<base>`, PR-style. `<base>` is a local branch, picked from the branch list and defaulting to the detected default branch (`GET git/branches`).
- The mode, base and toggle are per conversation, in the review state (Web client).
- Version naming depends on the mode (References): the old side is always a commit; the new side is one only in branch mode with uncommitted off.

## Server

### `GET /api/agents/:id/git/diff?base=<branch>&uncommitted=1`

`gitDiff(cwd, { base?, uncommitted? })` (`git/git.ts`):

- Every command runs in the agent's cwd. Tracked diffs use `--relative`, so paths are cwd-relative and changes outside the cwd's subtree are left out; untracked files come from `git ls-files --others --exclude-standard` run there. Blob lookups use `<rev>:./<path>`.
- Without `base`: uncommitted mode (tracked files against `HEAD`, plus untracked files as new-file patches); `uncommitted` is ignored.
- With `base`: `base` must not start with `-` and `refs/heads/<base>` must exist as written (`git show-ref --verify --quiet`, which rejects expressions such as `main~1`), else `400 invalid_body` "unknown branch <base>". A repo without commits → `400 invalid_body` "no commits yet". `git merge-base refs/heads/<base> HEAD` exiting 1 → `400 invalid_body` "<base> and HEAD have no common commit".
  - `uncommitted=1`: tracked files diffed from the merge-base to the working tree, plus untracked files.
  - Otherwise: `git diff <merge-base> HEAD`. Size checks use blob sizes (`git cat-file -s`) at `HEAD`, or at the merge-base for deleted files. Each file whose working-tree copy differs from `HEAD` (in `git diff --name-only -z --relative HEAD`) gets `worktreeChanged: true`.
- Limits: files over 1 MB (`MAX_PATCH_BYTES`) are listed `tooLarge` without a patch, binary patches are flagged, nested repos are listed without a patch.
- Outside a work tree → `404 not_a_git_repo`.

```ts
interface GitFileDiff {
  /* path, oldPath, status, patch, binary, tooLarge as before */
  worktreeChanged?: true;      // branch mode without uncommitted: the working tree differs from HEAD
}

interface GitDiffResponse {
  files: GitFileDiff[];
  oldRev?: string;             // `git rev-parse --short` of the old side (HEAD or the merge-base); absent without commits
  newRev?: string;             // short sha of HEAD when the new side is HEAD; absent when it is the working tree
}
```

### `GET /api/agents/:id/git/branches`

`listBranches(cwd)` (`git/refs.ts`):

```ts
interface GitBranchesResponse {
  branches: string[];          // local branches, most recent commit first
  defaultBranch: string | null;
}
```

- `branches`: `git for-each-ref --sort=-committerdate --format=%(refname:lstrip=2) refs/heads` (`refname:short` would write `heads/x` when a tag is also named `x`).
- `defaultBranch`: the local branch named by `refs/remotes/origin/HEAD` (`git symbolic-ref --quiet`, `refs/remotes/origin/` stripped) if it exists locally, else `main`, else `master`, else `null`. With `null`, branch mode waits for a pick.
- Outside a work tree → `404 not_a_git_repo`.

### `GET /api/agents/:id/files?q=<text>`

`searchFiles(cwd, q)` (`git/files.ts`):

- The candidates are `git ls-files --cached --others --exclude-standard -z` run in the cwd: tracked plus untracked files that aren't ignored, cwd-relative, deduplicated, without nested-repo entries (ending in `/`). They are listed on every request, with no cache.
- Scoring uses `fuzzysort` (server dependency, `^4`) with keys path and basename: `go(q, targets, { keys: [path, basename], limit: 10, threshold: 0, scoreFn: (r) => (r[1].score > 0 ? 1 + r[1].score : r[0].score) })`. Scores are 0–1 and an unmatched key scores 0, so every file whose basename matches ranks above every file matched only across directories (F16).
- `q` is trimmed. An empty `q` → `{ files: [] }`; over 200 characters → `400 invalid_body`.
- → `200 { files: string[] }`, best first, at most 10. Outside a work tree → `404 not_a_git_repo`.

### `GET /api/agents/:id/files/content?path=<path>`

`readProjectFile(cwd, path)` (`git/files.ts`) reads the working-tree copy:

- `path` is cwd-relative or absolute and is resolved against the cwd. Its realpath must be inside `realpath(cwd)`, else `400 invalid_body` "outside the project", which covers `..` and symlinks leading out. Missing, or not a regular file → `404 file_not_found`. Outside a work tree → `404 not_a_git_repo`.
- The diff's limits apply: over 1 MB → `tooLarge`, no content. A NUL byte in the first 8000 bytes (git's heuristic) → `binary`, no content. Otherwise the content is decoded as UTF-8.

```ts
interface FileContentResponse {
  path: string;                // cwd-relative, normalized
  content?: string;            // absent when binary or tooLarge
  binary: boolean;
  tooLarge: boolean;
}
```

### Routes and errors

`http/review-routes.ts` holds `/:id/git/diff`, `/:id/git/branches`, `/:id/files` and `/:id/files/content`. It is mounted at `/api/agents` beside `agentsRoutes` and resolves agents through `manager.require`. One new code: `file_not_found` (404).

### Refresh signal

`AgentPipeline.refreshGitStatus` publishes `git_status` after every scheduled refresh (2 s after `turn_end` and after a `!` command), changed or not. The startup read publishes only when the status differs. The status itself changes rarely (`dirty` ignores untracked files), so the event, not its content, is the signal: the web client refetches on every `git_status` (F13).

## References

### Syntax

```
@src/app.ts:42              one line
@src/app.ts:40-45           a range
@"my dir/a.ts":40-45        a path with whitespace, quoted (pi's TUI convention)
@3f2a9c1:./src/app.ts:40-45 lines of a committed version: git's `<rev>:./<path>`
```

- **Shape**: `@`, an optional `<rev>:`, a path, `:`, then `N` or `N-M`. Line numbers are decimal, 1-based and have no leading zero; `M > N` (`N-N` and `M < N` don't parse).
- **Rev**: 7–40 lowercase hex characters, always a commit sha (`git rev-parse --short` output), never a moving ref like `HEAD`.
- **Path**: quoted (`"…"`, no `"` or line break inside) or bare (no whitespace, `"` or backtick). The line spec is the first `:N` or `:N-M` followed by the End rule, so a bare path may contain `:` but no such segment: `@src/a.ts:12:5` (line:column) is line 12 of `src/a.ts`. A path is cwd-relative; absolute paths parse too.
- **Start**: a reference starts at the beginning of the text, after whitespace, or right after a backtick, so that inline code (`` `@a.ts:3` ``) counts in plain-text user messages.
- **End**: a reference is followed by the end of the text, whitespace, or one of `` ` . , ; : ! ? ) ] } ' " ``.
- Not references: `@scope/pkg`, `@someone`, `@a.ts` (no line), `a@b.c:25`, `(@a.ts:3)`. Bare `path:N` isn't linked (F17).

### Shared module

`packages/protocol/src/code-refs.ts` is the single implementation of the syntax. It is used by the composer overlay, whole-reference delete, insertion and transcript coloring:

```ts
interface CodeRef { path: string; start: number; end: number; rev?: string }
interface CodeRefMatch extends CodeRef { index: number; length: number }  // UTF-16 offsets in the text

/** `@path:N` / `@path:N-M` / `@rev:path:…`; null when the path can't be written (contains `"` or a line break, or is empty). */
function formatCodeRef(ref: CodeRef): string | null;
/** Every reference in `text`, in order, non-overlapping. */
function findCodeRefs(text: string): CodeRefMatch[];
```

`formatCodeRef` quotes a path whose bare form wouldn't read back as the same path: one that contains whitespace or a backtick, begins like a rev (`<7–40 hex>:`), or contains a `:N` segment that would end it early (`a:3`). It writes `N` when `start === end`. With a rev, it writes a path not starting with `./` or `../` as `./<path>`: git resolves `<rev>:./<path>` from the current directory, so `git show <sha>:./<path>` works from a subfolder cwd, while `<rev>:<path>` resolves from the repo root. `findCodeRefs` drops that `./` after a rev, so a reference's `path` is cwd-relative either way and `formatCodeRef` output round trips.

### Version naming

A reference names a version only when its lines may not match the file on disk:

| Selected in | Side | Reference |
|---|---|---|
| Changes | old (deleted or old-side lines) | `@<oldRev>:./<oldPath ?? path>:N-M` |
| Changes, new side is HEAD | new | `@<newRev>:./<path>:N-M` when the file has `worktreeChanged`, else `@<path>:N-M` |
| Changes, new side is the working tree | new | `@<path>:N-M` |
| File viewer | — | `@<path>:N-M` |
| Transcript edit/write diff | either | `@<path>:N-M`, as shown, never versioned (F14) |

A transcript tool diff's path is the tool's `path` argument, made cwd-relative when it is an absolute path inside the cwd. A path `formatCodeRef` can't write isn't inserted; a toast says so.

## Composer

### Draft store

`store/drafts.ts` holds one draft per conversation, in memory, for the tab's lifetime. It keeps the text across navigation (F9) and is the composer's only text state:

```ts
interface Draft {
  text: string;
  selection: { start: number; end: number };  // the textarea's, updated on select/input/blur
  attachments: Attachment[];                  // features/conversation/attachments.ts
  external: number;                           // bumped by changes made outside the composer
}

interface Drafts {
  drafts: Record<AgentId, Draft>;
  edit(agentId, text, selection): void;       // typing
  setAttachments(agentId, attachments): void;
  replace(agentId, text): void;               // fork, share, set_editor_text, Stop & edit; caret at the end; bumps `external`
  insertReference(agentId, ref: string): void; // at the selection; bumps `external`
  clear(agentId): void;                       // on send
}
```

- Sending clears the draft before the request. A failed send restores the text and attachments only into a still-empty draft, so text typed while the request was in flight survives and a second Enter has nothing to send.

- `insertReference` replaces the selection with the reference. It adds a space before it unless it lands at the start or after whitespace, and a space after it unless whitespace follows. The caret goes after the inserted text.
- When `external` changes, the mounted composer focuses the textarea and applies the stored selection. A composer mounting later (phone, back from the diff page) does the same if `external` changed since its last mount.
- Fork (`session-actions.ts`) and share (`share-screen.tsx`) hand text over with `replace`; `useConversationUi` holds only the action-sheet state.

### Highlight overlay

`ComposerInput` (`features/conversation/composer-input.tsx`) is the native `<textarea>` over an `aria-hidden` mirror `div` (F7, F8):

- Both have the same font and size (`text-base md:text-sm`), padding, line height, `whitespace-pre-wrap break-words` wrapping and width. Both have `scrollbar-gutter: stable`, so the textarea's scrollbar past `max-h-48` doesn't narrow its text against the mirror's. The mirror renders the text with every `findCodeRefs` match in a blue span (`text-blue-600 dark:text-blue-400`), plus a trailing zero-width space so a final empty line keeps its height.
- The textarea has `text-transparent`, a visible caret and a translucent selection color. The mirror sits behind it, `pointer-events-none`, and copies its `scrollTop` on `scroll`. Autosizing (`field-sizing-content`, or the existing fallback) stays on the textarea; the mirror fills the same box.
- IME, autocorrect and the caret stay native. Typing inside a reference edits it as plain text, so a broken reference turns back to normal color.

### Whole-reference delete

In `onChange`, the new value is compared with the previous one. When the edit only removes text, and the removed range overlaps a reference of the previous text without covering it, the whole reference is removed instead and the caret goes to where it started. This covers Backspace, Delete, cut and keyboards that recompose the previous word, whatever events they send. Insertions are left alone.

- The removed range comes from the selection before the edit: the selection itself when it was a range, else the characters just before (Backspace) or after (Delete) the caret, whichever yields the new value. The common prefix and suffix are the fallback. Prefix and suffix alone misplace a deletion among repeated characters: deleting a selected `@ ` from `x @ @a.ts:3` looks like deleting ` @`, which overlaps the reference.
- While an IME composes (`nativeEvent.isComposing`), the value isn't rewritten: rewriting it mid-composition makes Gboard abort or duplicate the composition. On `compositionend` the value is compared with the one at `compositionstart` and the same rule applies.

## Line selection

### Diff viewer

`DiffViewer` (`components/diff`) gains:

```ts
interface LineSelection { side: "old" | "new"; start: number; end: number }

interface DiffViewerProps {
  /* patch, fileName, className, maxLines as before */
  onSelectLines?: (selection: LineSelection) => void;
  selection?: LineSelection | null;            // lines to mark; null clears; undefined leaves the library's own mark
  scrollTo?: { line: number; nonce: number };  // new-side line to center
  unified?: boolean;                           // force unified (file viewer)
}
```

With `onSelectLines`, `diff-view-impl.tsx` renders `DiffViewWithMultiSelect` (F3) and reports `onMultiSelectComplete`'s range. Without it, it renders `DiffView`. Without `selection`, a finished selection stays marked through the library's preselected lines until the next one.

- **One `DiffFile` per patch.** The view's `data` is memoized on the parsed patch, and `DiffViewWithMultiSelect` is keyed on it. The library builds a new `DiffFile` whenever `data` is a new object and clears the old one, while its selection manager keeps the `DiffFile` it was created with; an inline `data` would leave the manager with a cleared file after any re-render (new props, theme, a refetch), so selections would report no lines and mark nothing. A new patch remounts the view with a new manager.
- **`selection`** is applied through the view's ref: `setPreselectedLines` with the range, or `clearSelection` plus `setPreselectedLines({ old: [], new: [] })` for `null`. It is applied in an effect, after the library's own mouseup handling: the library clears the preselection on mousedown and marks only the line just tapped after calling `onMultiSelectComplete`, so a range set from inside that callback would be overwritten.
- **When it applies**: `selection` and `scrollTo` are applied on the view's mount and on each change (of value, or of `nonce`), once the rows exist. The view is lazy-loaded and builds its rows in its own effects, and behind the large-patch guard it mounts only after "Show anyway"; so the impl waits for `[data-line-new-num]` (for `scrollTo`, `[data-line-new-num="<line>"]`) with `requestAnimationFrame`, giving up after 60 frames. `scrollTo` scrolls that row into view, centered.

### Selectable diff

`SelectableDiff` (`features/review/selectable-diff.tsx`) wraps `DiffViewer` for every selectable surface: Changes, the file viewer and transcript edit/write diffs. It takes `toReference(selection) → CodeRef`, an optional `onAdded` and an optional `highlight` (`{ start, end, nonce }`, new side). It turns a selection into `formatCodeRef(toReference(selection))` and inserts it with `insertReference`. The agent id and cwd come from the conversation store (`useConversation`), since tool renderers get neither. As `selection` it passes `highlight` on desktop; on phone, the pending selection while it owns one, else `highlight` or `null`, so a diff that loses the pending selection unmarks it. `highlight` also goes as `scrollTo`.

- **Desktop** (≥1024px): a click on a line number selects one line, a drag across line numbers selects a range on one side (no shift-click). Releasing the mouse inserts the reference and focuses the composer.
- **Phone** (<1024px): taps on the line-number column reach the library as the browser's compatibility mouse events, each completing a one-line selection. A bar fixed at the bottom of the screen (`AddToChatBar`, rendered by the `SelectableDiff` that owns the pending selection) follows the selection. The first tap marks the start line and the bar reads "Tap the last line" with **Cancel**. The second tap on the same side marks the range from the first to the second line (either order); tapping the same line twice gives one line. The bar then shows the reference text, **Add to chat** and **Cancel**. A tap on the other side, or a third tap, starts over. A completion spanning several lines (a mouse drag in a narrow desktop window) becomes the range directly. A new patch for the diff (an auto-refresh can shift its lines) clears its pending selection. One pending selection exists at a time across the screen (`features/review/line-selection.ts`, a small Zustand store keyed by the diff instance); other diffs clear theirs. **Add to chat** inserts the reference, clears the selection and runs `onAdded`. The review page passes navigation back to `/agents/$agentId`, so each trip adds one reference; in the transcript the selection just clears.
- Phone screens are always unified (the viewport is below 1024px), so a context line selects the new side and a deleted line the old side, as the library decides.

Transcript renderers (`tools/file-edits.tsx`) render `SelectableDiff` with the tool's path, made relative to `agent.cwd` from the conversation store.

## Review panel

`ReviewPanel` (`features/review/review-panel.tsx`) renders the tab bar (Changes, Files), a Refresh button for the active tab, and the active tab. It is used by the desktop pane and the phone page.

### Review state

`features/review/review-state.ts`: a Zustand store keyed by agent id. Only `paneOpen` is persisted, to `localStorage` (`pi-code:review`), and only for conversations with the pane open; the rest lasts for the tab's lifetime:

```ts
interface ReviewState {
  paneOpen: boolean;                                   // desktop only
  tab: "changes" | "files";
  diff: { mode: "uncommitted" | "branch"; base?: string; uncommitted: boolean };
  files: { query: string; path?: string; target?: { start: number; end: number; nonce: number } };
}
```

`useReview(agentId)` reads an entry with defaults (`paneOpen: false`, Changes, uncommitted mode). Setters update the entry, among them `openPane(agentId, tab?)`, `togglePane` and `openFile(agentId, path, target?)`.

### Changes tab

`ChangesView` (`features/review/changes-view.tsx`) holds the file list (`FileRow`, `Totals`, empty and error states) under a mode bar:

```
(•) Uncommitted  ( ) Branch
    Base [main ▾]  [ ] Include uncommitted       ← branch mode only
3 files changed · +12 −4
▸ M  src/app.ts                           +3 −1
```

- The base is a native `<select>` over `GET git/branches` (`["agent", id, "branches"]`, fetched when branch mode is shown). It defaults to `defaultBranch` until a base is stored; with no default and no stored base, the list asks to pick one. Errors from the diff (an unknown or deleted base) show inline with the picker still usable.
- Query `queryKeys.gitDiff(agentId, mode, base, uncommitted)` = `["agent", id, "review", "diff", …]` → `getGitDiff(id, { base, uncommitted })`. The empty state reads "No changes. The working tree is clean." in uncommitted mode and "No changes against <base>." in branch mode.
- Each expanded file renders `SelectableDiff`, with `toReference` per Version naming from the response's `oldRev`, `newRev` and the file's `worktreeChanged`.

### Files tab

`FilesView` (`features/review/files-view.tsx`) shows the search, or the viewer once a file is open:

- **Search**: the cmdk `Command` with `shouldFilter={false}`. The input is debounced 250 ms (`useDebouncedValue`), as the project picker's path field, and queries `GET files?q=` (`["agent", id, "files", q]`). It shows up to 10 results, the basename in front and the directory muted, picked with the arrow keys and Enter or a tap. An empty query shows "Type to search files". The query is kept in the review state.
- **Viewer** (`features/review/file-viewer.tsx`): a header with the path and a back button to the search, then `GET files/content` (`["agent", id, "review", "file", path]`). Text renders through `SelectableDiff` with `unified` and a synthetic all-context patch, `fileAsPatch(path, content)` (`parse-patch.ts`): `--- path` / `+++ path` / `@@ -1,N +1,N @@` and every line prefixed with a space. The old-number column is hidden with CSS on the viewer's wrapper. `DiffViewer`'s existing guard ("Show anyway" past 1500 lines or 400k characters) applies. `binary`, `tooLarge` (1 MB), an empty file, `file_not_found` ("This file no longer exists") and `not_a_git_repo` get messages. A `target` passes as `highlight` (marked and scrolled to once the rows render, after "Show anyway" included); a target past the file's last line opens the file without a highlight and a toast "<path> has only N lines".
- References from the viewer are `@path:N-M` (always the new side).

Outside a git work tree both tabs show "This project isn't a git repository."

### Auto-refresh

When `LiveRegistry` applies a `git_status` event to an opened store, or hydrates a store after a snapshot refetch (events arriving during the refetch are dropped), it invalidates `["agent", id, "review"]`. That refetches the mounted Changes diff and open file, and marks the others stale. Branches and search results aren't refetched. The Refresh button refetches the active tab's queries.

## Desktop pane

At ≥1024px (`useIsDesktop`), the conversation route renders the review panel as a pane when `paneOpen`:

```
┌ sidebar ┬ conversation (50%)            ┬ [Changes][Files]      ⟳ ×  (50%) ┐
│         │ header · transcript · composer │ mode bar / search · diffs, viewer │
└─────────┴────────────────────────────────┴───────────────────────────────────┘
```

- `ConversationScreen` becomes a row: the conversation column and `ReviewPane` (`features/review/review-pane.tsx`) split the content width in halves, each `h-dvh` with its own scroll. The pane can't be resized. While the pane is open the conversation drops its `lg:px-32` padding to `lg:px-6` (header, transcript and composer columns). Scoped dialog sheets stay in the conversation column.
- The pane header holds the tabs, Refresh and a Close (×) button.
- Opening and closing: a header button (`FileDiffIcon`, "Show changes" / "Hide changes", `aria-pressed`) and `/diff` toggle `paneOpen`, opening on the stored tab. On desktop the header menu has no Diff item.
- `paneOpen` is per conversation and survives a reload (review state). The tree route shows no pane.
- `/agents/$agentId/diff` on desktop calls `openPane(agentId)` and replaces itself with `/agents/$agentId`.
- Below 1024px the pane isn't rendered and the phone flow applies, whatever `paneOpen` says.

## Phone page

`/agents/$agentId/diff` (`features/diff/diff-screen.tsx`) is the review panel as a page: the back chevron to the conversation, the tabs, Refresh, then the active tab. Files is reached only through this page's tab. The header menu's Diff item and `/diff` navigate here. Selections use the Add to chat bar, which returns to the conversation, where the composer shows the draft with the reference at the saved caret.

## Clickable references

### Rendering

- **User messages** (`transcript/user-message.tsx`, committed and pending): the body after `<file>` blocks renders through `CodeRefText` (`features/review/code-ref-text.tsx`). It splits plain text by `findCodeRefs` and renders each match as a blue `button` showing the original text.
- **Assistant text blocks** (`assistant-message.tsx`): `Markdown` gains `codeRefs?: boolean`. When set, the rehype plugin `rehypeCodeRefs` (`lib/code-refs-rehype.ts`), appended after `harden`, splits text nodes, those inside inline `code` included, into `span[data-code-ref]` elements, blue and `role="button"` with `tabIndex=0`. Text inside `pre` and `a` is left alone, and so is every other Markdown surface (thinking, tool output, custom messages). Each text node is scanned on its own, so a node start counts as a reference start (inline code, emphasis). A click or Enter on `[data-code-ref]` is handled by delegation on the message wrapper, which parses the element's text again with `findCodeRefs`.

### Opening

`useOpenReference()` (`features/review/open-reference.ts`):

1. `openFile(agentId, ref.path, { start, end, nonce })` and `tab: "files"`.
2. Desktop: `paneOpen = true`. Phone: navigate to `/agents/$agentId/diff`.
3. A reference with `rev` opens the current file at those lines, with a toast: "That reference points at version <rev>; showing the current file."

The server resolves the path against the cwd, so absolute paths inside it work. Paths outside the project, missing files and non-git projects show the viewer's message.

## pi extension: reference guideline

`packages/pi-extension/src/index.ts` adds the guideline to every run's system prompt through structured prompt options, leaving the user's `APPEND_SYSTEM.md` untouched (F19–F21):

```ts
export const REFERENCE_GUIDELINE =
  'When you point to specific lines of code, write the reference as `@path:N` for one line or `@path:N-M` for a range, with the path relative to the working directory. Quote paths that contain spaces: `@"dir name/file.ts":N`. The user can click these references to open those lines.';

pi.on("before_agent_start", (event) => {
  const options = event.systemPromptOptions;
  if (options.customPrompt) {
    if (!options.appendSystemPrompt.includes(REFERENCE_GUIDELINE))
      options.appendSystemPrompt = [options.appendSystemPrompt, REFERENCE_GUIDELINE].filter(Boolean).join("\n\n");
  } else if (!options.promptGuidelines.includes(REFERENCE_GUIDELINE)) {
    options.promptGuidelines.push(REFERENCE_GUIDELINE);
  }
});
```

The handler returns nothing, so pi keeps building the prompt from its sections. pi renders `promptGuidelines` only without a custom prompt (a user's `SYSTEM.md`), so with one the guideline joins `appendSystemPrompt`, which already holds the loaded `APPEND_SYSTEM.md`. The extension's `@earendil-works/pi-coding-agent` dev dependency moves from `0.87.1` to `1.1.0`, whose `BeforeAgentStartEvent.systemPromptOptions: NormalizedBuildSystemPromptOptions` has `promptGuidelines: string[]`. The protocol package keeps its own pin.

## Tests

- **Protocol**: table tests for `findCodeRefs` and `formatCodeRef` (every syntax rule, the non-references, round trips).
- **Server**: real `git` in temp dirs for the diff modes, merge-base, `worktreeChanged`, revs, subfolder scoping, branches and default detection, file listing, search ranking and reads. Harness route tests for the four routes and the `git_status` refresh. A unit test for the extension's handler.
- **Web**: unit tests for the draft store and the rehype plugin; component tests for the composer overlay and delete, `SelectableDiff` on desktop and phone (mouse events on line-number spans, with the canvas stub), the review panel, pane and page, the file viewer and reference opening.

Coverage per task is in [`../plan/07-code-review.md`](../plan/07-code-review.md).

## Limitations

- References from transcript edit/write diffs are inserted as shown; later edits can shift their lines, and no commit names that version (F14).
- The pane is usually below 1024px wide, so it shows unified diffs (F18). It can't be resized.
- Nothing watches the working tree. Edits from an editor or a TUI pi show after the next agent turn, `!` command or Refresh (F12).
- In agent replies, only `@path:N` is linked; bare `src/foo.ts:42` isn't (F17). References in fenced code blocks aren't linked. Each Markdown text node is scanned on its own, so a reference split by Markdown syntax outside inline code (`@pkg/__init__.py:3`, whose `__init__` becomes bold) isn't linked.
- A version-named reference opens the current file; old versions aren't shown.
- A conversation in a subfolder of a repo sees only that subtree's changes and files, while the header's dirty marker covers the whole repo.
- Branch mode compares with a local branch; a local default branch behind its remote includes commits already upstream.
- Editing a reference's characters turns it into plain text; only deletions remove it whole (F8).
- Phone selection relies on the browser's compatibility mouse events for taps on the line-number column; selection is on one side only (F3).
- The flow follows the viewport width, not the input: a tablet at ≥1024px gets the desktop flow, where touch can't drag, so it selects single lines only.
- Paths containing `"` or a line break can't be referenced.
- Drafts survive navigation, not a reload.
- File search lists tracked files deleted from the working tree; opening one says it no longer exists. The explorer is search-only, with no folder tree.
