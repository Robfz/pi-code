# Plan — UI overhaul (phase 1)

Spans `packages/protocol` and `packages/web`. Design: `design/09-ui-overhaul.md`; decisions: `maps/2026-10-10-ui-overhaul.md`; reference: `design/mockups/ui-overhaul.html`. Seven slices, in order; each ships on its own and leaves `pnpm check && pnpm test` green:

| Slice | Tasks |
|---|---|
| A. Foundations: tokens, fonts, motion, Shiki, column, status vocabulary | U1–U4 |
| B. Timing in `reduceLive` | U5 |
| C. Transcript primitives: collapsible, tool rows, turns, user message, thinking | U6–U9 |
| D. Exploration grouping and density | U10–U11 |
| E. Live-status row and turn footer | U12–U13 |
| F. Composer and model picker | U14–U15 |
| G. Docs | U16 |

## Test strategy

- **Protocol:** unit tests in `live.test.ts` with explicit `receivedAt`s; the fixture suite (`fixtures.test.ts`) keeps the reconnect invariant (snapshot at every event index plus the rest equals the full reduction) over every recorded fixture.
- **Web, pure logic:** unit tests for `agentStatus`, `selectTurns` and turn stats, `groupSteps`, and the preference migration, on hand-built entries and the recorded fixtures (`fixtureTranscript`, `fixtureToolCall` / `propsAt` from `tools/testing.ts`).
- **Web, components:** Testing Library with `hydratedStore` / `renderWithStore` (`test/render.tsx`), `stubMatchMedia` for desktop and phone, `lib/api.ts` mocked as in `status-bar.test.tsx`, fake timers for elapsed times. Shimmer and colour are asserted through classes and labels, not pixels.
- Visual fidelity to the mockup is checked by hand (End-to-end verification).

## A. Foundations

### U1 — Tokens, fonts, type scale and motion
- `packages/web/package.json`: `@fontsource-variable/geist-mono`.
- `src/index.css`: the Geist Mono import; `--font-sans` and `--font-mono`; `--text-sm` (13px / 1.4) and `--text-prose` (15px / 1.65) in `@theme`; the design's light (`:root`) and dark (`.dark`) values for shadcn's variables and the new ones (`--user-message`, `--chip`, `--subtle-foreground`, `--faint-foreground`, `--link`, `--status-*`, `--diff-*`), each mapped in `@theme inline`; the `shimmer` utility and keyframes; the reduced-motion rule; `code, kbd, pre, samp` in `font-mono`.
- Done when: `pnpm check && pnpm test` pass; `pnpm --filter @pi-code/web build` emits a Geist Mono `woff2` that the precache manifest in `dist/sw.js` lists; in a browser, `getComputedStyle` on `code` reports Geist Mono and `--background` matches the design in both themes.

### U2 — Colour tokens, code blocks and links
- Raw palette classes become tokens (design, "Colour"): `tools/file-edits.tsx`, `tools/subagent.tsx` (also `text-[11px]` → `text-xs`), `tools/common.tsx` (link `text-link`), `features/review/changes-view.tsx`, `components/diff/diff-viewer.tsx`, `features/conversation/status-bar.tsx` (context bar, dirty dot), `features/tree/tree-screen.tsx`, `features/conversation/composer-input.tsx` (selection), `lib/code-refs.ts` (`CODE_REF_COLOR = "text-link"`).
- `lib/code-highlighter.ts`: `vitesse-light` / `vitesse-dark`.
- `components/markdown.tsx` and `src/index.css`: prose at `text-prose`, headings 20/17/15px, code block chrome on `[data-streamdown="code-block"]` (language and copy only), inline code chip, links, line-reference chips.
- Done when: `markdown.test.tsx` covers a code block showing its language and a copy button and no download button, links carrying `text-link`, and line references as `text-link` chips; a `code-highlighter` test asserts `getThemes()` is the Vitesse pair; existing review, diff and tool tests pass with the token classes.

### U3 — Status vocabulary
- `lib/agent-status.ts`: `agentStatus(agent, pending)`.
- `components/agent-status.tsx`: `StatusMark` and `StatusBadge`, in place of `components/attention-badge.tsx`.
- `features/sidebar/sidebar.tsx`: `RowMark` → `StatusMark`, the attention icon removed. `routes/home.tsx`: `AgentRow` shows one `StatusBadge` (`statusLabel` removed). `features/catalog/session-list.tsx`: a session held by an agent shows that agent's `StatusBadge`. `features/conversation/status-bar.tsx`: `RunIndicator` reads "Working". `features/conversation/connection-indicator.tsx`: the design's tokens.
- Done when: `agent-status.test.ts` covers every row of the table and the precedence (input over working, working over failed, failed on an exited agent, a pending resume as working, a session row as closed); `sidebar.test.tsx` ("marks rows per status") asserts the spinner for Working, a labelled dot per status and no mark for Closed; `catalog.test.tsx` asserts Home's badges and the held-session badge; `status-bar.test.tsx` asserts "Working" while running, compacting and retrying; `rg "(emerald|amber|red|green|blue|sky)-[0-9]|text-\[11px\]" packages/web/src` finds nothing.

### U4 — Transcript column
- `features/conversation/conversation-screen.tsx`: the transcript and composer columns `mx-auto w-full max-w-[46rem] px-4 lg:px-6`, with and without the review pane; the `lg:px-32` / pane padding switch removed.
- Done when: `conversation-screen.test.tsx` asserts both columns carry the cap on desktop with the pane closed and open, and on phone.

## B. Timing in `reduceLive`

### U5 — Timing fields
- `packages/protocol/package.json`: `@earendil-works/pi-agent-core`, `pi-ai` and `pi-coding-agent` `1.1.0` (dev dependencies, the installed pi's version); `pnpm install` updates the lockfile; type errors from the bump in `protocol`, `server` and `web` are fixed.
- `packages/protocol/src/live.ts`: `startedAt` / `endedAt` on `StreamingBlock`, `startedAt` / `durationMs` on `ToolRun`, `startedAt` on `LiveRun`, `thinkingMs` on `LiveState`, as in the design (`reduceMessageUpdate` receives `receivedAt`).
- Done when: `live.test.ts` covers a thinking and a text block's `startedAt` / `endedAt`, a block created by a delta getting `startedAt`, events without `receivedAt` leaving the fields absent, a tool's `startedAt` kept through updates and the end, `durationMs` from the event and, without it, from `receivedAt`, `agent_start` setting `run.startedAt` and `agent_settled` dropping it, `thinking_end` writing `thinkingMs` under the message timestamp and content index and settling keeping it; `fixtures.test.ts`'s invariant passes for every fixture.

## C. Transcript primitives

### U6 — Collapsible row
- `components/ui/collapsible.tsx` (shadcn, on `radix-ui`) and `components/collapsible-row.tsx` (`CollapsibleRow`).
- Every `<details>` becomes a `CollapsibleRow`: `features/conversation/transcript/thinking.tsx`, `user-message.tsx`, `dividers.tsx`, `bash-execution.tsx`, `tools/web-access.tsx`, `tools/subagent.tsx`, `tools/custom-messages.tsx`, `tools/generic.tsx`, `tools/mcp.tsx`.
- Done when: `collapsible-row.test.tsx` covers toggling by click, Enter and Space with `aria-expanded`, controlled `open`, the tail shown while open, and a row without a body having no chevron and not toggling; `rg "<details" packages/web/src` finds nothing; the tests of every converted component pass against button semantics.

### U7 — Tool rows and labels
- `tools/registry.ts`: `ToolLabel`, `label()` in place of `Summary`; `ToolRendererProps` gains `durationMs` and `startedAt`.
- `tools/tool-row.tsx` (`ToolRow`); `tools/tool-call-view.tsx` renders it, expansion still driven by `toolsExpanded`; `features/conversation/transcript/tool-call-slot.tsx` passes the committed `toolResult.durationMs`, else the live run's `durationMs` and `startedAt`.
- Labels per the design's table in `tools/builtin.tsx`, `file-edits.tsx`, `subagent.tsx`, `web-access.tsx`, `mcp.tsx`, `generic.tsx`; `expandWhileRunning` only on `bash` and the fallback renderer. Subagent cards render nested calls as body-less `ToolRow`s.
- `lib/use-elapsed.ts`: `useElapsed(startedAt)`, ticking every second.
- Done when: per-tool tests (`builtin.test.tsx`, `web-access.test.tsx`, `mcp.test.tsx`, `subagent.test.tsx`, `registry.test.tsx`), on fixture calls at `start`, `end` and an error, assert the icon, the running, done and failed verb, the target and the meta of every row in the table; `tool-row.test.tsx` covers `shimmer` only while running or streaming, the error icon, verb and first error line, the duration from `durationMs` and the elapsed time with fake timers, the Review button under a collapsed row with a curator URL; `subagent.test.tsx` covers nested rows; the transcript fixture tests still count every call.

### U8 — Turns
- `store/turns.ts`: `selectTurns`, `Step`, and `turnStats(turn)` → `{ durationMs?, cost, files?, finalText? }`.
- `features/conversation/transcript/turn.tsx` (`TurnView`); `transcript.tsx` renders turns; `live-section.tsx` feeds the live turn (streaming blocks, orphan tools, a pending user message starting a new turn) and keeps `!cmd` runs after the turns.
- Done when: `turns.test.ts` covers, on fixtures, one turn for `plain-answer`, a steer starting a new turn (`steer-followup`), a leading turn without user message (`entry-types`), every visible entry in exactly one turn, stop notices as steps, the final text after the last tool step and none when the turn ends in a tool call, the duration from timestamps plus `durationMs` and without it, the cost including subagent spend (`subagent`), and the files from `tool-calls`' edits and writes; `transcript.test.tsx`'s per-fixture counts still pass; a live-turn test shows streaming blocks appended to the last turn and a pending user message as a new turn.

### U9 — User message and thinking
- `features/conversation/transcript/user-message.tsx`: the full-width box.
- `features/conversation/transcript/thinking.tsx`: the thinking row (live preview, "Thought for Ns", "Thought", redacted).
- Done when: `user-message.test.tsx` covers the box (no right alignment), pending at 70% opacity, attachments as collapsible rows; `thinking.test.tsx` covers "Thinking" with `shimmer` and the latest line as preview while collapsed, "Thought for 12s" from `startedAt` / `endedAt`, "1m 4s", "Thought" without timing, "Thought (redacted)" without chevron, and the expanded body not italic.

## D. Exploration grouping and density

### U10 — Exploration groups
- `features/conversation/transcript/grouping.ts`: `groupSteps`. `TurnView` renders groups as `ExplorationGroup` rows.
- Done when: `grouping.test.ts` covers consecutive exploration calls grouping, thinking between two calls absorbed, leading and trailing thinking left out, a lone call ungrouped, breaks on text, `edit`, `write`, `bash`, `spawn`, `mcp`, an unknown tool, an entry and a stop notice, a failed call breaking out, empty text ignored, and the count label's plurals and order; `exploration-group.test.tsx` covers "Exploring · Reading foo.ts" with `shimmer` while a child runs, "Explored …" when done, the children in the body, and a child's Review button under the collapsed group (`web-search` fixture).

### U11 — Density
- `store/ui-prefs.ts`: `density` and `setDensity`, version 1 with the `toolsExpanded` migration; `toolsExpanded` removed.
- `TurnView`, `ToolRow`, thinking and group rows: default open state per density; local overrides reset on a density change; Compact's "Worked" row and live view; Detailed without grouping.
- `features/conversation/header.tsx`: the density dropdown in place of the expand toggle. `features/settings/settings-screen.tsx`: "Transcript density" in place of "Tool calls".
- Tests that set `toolsExpanded` (`registry.test.tsx`, `builtin.test.tsx`, `features/review/selectable-diff.test.tsx`) set `density`.
- Done when: `ui-prefs.test.ts` covers the migration (`toolsExpanded: true` → detailed, `false` → balanced, nothing stored → balanced); `turn.test.tsx`, on the `tool-calls` fixture, covers Compact's "Worked for …" row, final text and footer without duration, the "Worked" row expanding to grouped rows, a live Compact turn showing only the streaming text, Balanced with a running `bash` row expanded and collapsed once done, Detailed with no group and every row and thinking expanded, and a locally toggled row kept until the density changes; `header.test.tsx` covers the dropdown's three levels, the check on the current one, and choosing one; `settings-screen.test.tsx` covers the three choices with `aria-pressed`; `rg toolsExpanded packages/web/src` finds nothing.

## E. Live-status row and turn footer

### U12 — Live-status row
- `features/conversation/transcript/live-status.tsx` (`LiveStatusRow`) in place of `RunStatus` in `live-section.tsx`; `selectLiveActivity` in `store/selectors.ts` (the phrase, and whether a row shimmers).
- Done when: `live-status.test.tsx` covers each phrase (compaction, "Retrying 2/3 · reason", thinking, "Reading foo.ts", "Running pnpm test", "Working"), the row hidden in Balanced while a tool runs or streams and while thinking is live, shown in Compact, the timer from `run.startedAt` with fake timers and absent without it, and the run error's alert.

### U13 — Turn footer
- `features/conversation/transcript/turn-footer.tsx`, rendered by `TurnView`.
- Done when: `turn-footer.test.tsx` covers the footer on finished turns only, duration, cost and files with their formatting, no duration in Compact, no files chip without edits or writes, the chip opening the pane's Changes tab on desktop and navigating to `/agents/$agentId/diff` on phone, Copy writing the final text (clipboard mocked), and no Copy without final text.

## F. Composer and model picker

### U14 — Composer layout and running state
- `features/conversation/composer.tsx`: the box, the `Plus` attach button, round Send, and the running-state buttons (Stop always; Queue and Steer only with a draft). `features/conversation/queue-display.tsx`: Stop & edit.
- Done when: `composer.test.tsx` covers "Attach file", Send idle, Stop present while running with an empty draft and Queue and Steer absent, Queue and Steer appearing with text or an attachment and sending `followUp` and `steer`, Enter and Alt+Enter unchanged; the Stop & edit test passes from the queue display.

### U15 — Model picker and status bar
- `features/conversation/model-picker.tsx` (`ModelPicker`) in the composer footer; `action-sheets.tsx`: a `ThinkingLevelControl` (the segmented control) used by the picker and the model sheet.
- `features/conversation/status-bar.tsx`: model, thinking and session name removed; the design's order.
- Done when: `model-picker.test.tsx` covers the label (name and level, "No thinking", name alone without reasoning), the desktop popover listing models by provider with search, choosing one sending `set_model` and closing, the level control sending `set_thinking_level` and hidden without reasoning, and the phone opening the model sheet with the level control; `status-bar.test.tsx` (the picker tests moved out) covers folder, branch and dirty dot, context, cost with `(sa $x)`, chips and Working, and no model, thinking or name.

## G. Docs

### U16 — Update the docs and README
- `docs/design/03-web-client.md`: the shell table's conversation column, `/settings` (density), "Transcript rendering" (turns, rows, thinking, density), "Tool renderers" (`label()`, the row), "Composer" (layout, picker, running state), "Status bar", line references' colour; links `09-ui-overhaul.md`.
- `docs/design/05-desktop.md`: the sidebar's row marks (status vocabulary), "Layout" (transcript width, no pane padding switch), the sidebar sketch.
- `docs/design/02-api-contract.md`: the `LiveState` timing fields.
- `README.md`: Known limitations (thinking durations, the files chip's working tree), Documentation (link the design).
- Done when: no doc mentions `toolsExpanded`, the header's tool expansion toggle, model or thinking in the status bar, `lg:px-32`, a green live dot or the sidebar's attention icon; `03` and `05` link `09-ui-overhaul.md`.

## End-to-end verification

On the Mac in a browser over the tailnet URL (desktop, ≥1024px), then on the Android phone, both in light and dark theme:

1. Compare a conversation with the mockup's mono screenshots: Geist Sans prose at 15px, Geist Mono in code, neutral greys, blue only on links and line references, Vitesse code blocks with language and copy.
2. Start a run that reads, greps, edits and runs a command. While it runs: the exploration group reads "Exploring · Reading …" with a shimmer, the running `bash` row is expanded with streaming output and collapses when done, the live-status row appears only between steps with a ticking timer, and "Thinking" shows a one-line preview.
3. Reload mid-run: running rows keep their elapsed time and the timer continues.
4. When it finishes: past-tense rows, durations on hover, a footer with duration, cost and "N files +a −d"; the chip opens the review pane (desktop) or the diff page (phone); Copy copies the final answer.
5. Switch density in the header: Compact folds the turn into "Worked for …", Detailed ungroups and expands everything; expand one row by hand, switch density, and it resets. Settings shows the same choice; it survives a reload. An old `toolsExpanded: true` preference opens as Detailed.
6. Fail a tool (read a missing file): a red "Read failed" row with the error's first line, outside any group.
7. Composer: idle Send is solid foreground; while running, Stop alone, then Queue and Steer once text is typed; Enter steers, Alt+Enter queues; Stop & edit appears with queued messages.
8. Picker: on desktop the popover searches models, switches model, and changes the thinking level; on a non-reasoning model the level control is gone. On phone the button opens the model sheet with the level control.
9. Sidebar and Home: a running conversation shows a spinner and "Working", a dialog amber "Needs input", a finished run green "Finished", a failed one red, an idle live one a muted dot, sessions no mark; nothing else is green.
10. With the review pane open on desktop, the transcript column narrows to fit; on phone the column fills the width with its padding.
11. Turn on reduced motion (OS setting): no shimmer animation, collapsibles open instantly.
12. Load an old session recorded before pi 1.1.0: rows without durations, "Thought" without a duration, footers still showing cost and files.
