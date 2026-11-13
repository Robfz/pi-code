<!-- pi:map -->
# pi-code — UI/UX overhaul (phase 1): decision map

Builds on [2026-09-30-desktop.md](2026-09-30-desktop.md). Reference: Cursor's Agents Window (Cursor 3.x), plus a market survey of agent-orchestrator UIs (Claude Code desktop, Codex app, Conductor, VS Code Agents/Copilot, Antigravity, Zed, T3 Code, Warp, Amp).

## Scope & context
- [settled] Goal: bring the web client's look and feel up to the level of Cursor's Agents Window, specifically typography, tool-call and thinking presentation, and the composer. User's call.
- [settled] Scope is phase 1 only: foundations (A1–A4), transcript (B5–B10) and composer pickers (C11). User's call.
- [deferred] Phase 2, navigation and attention (desktop Home inbox, unread state in sidebar, keyboard layer and ⌘K palette, desktop dialogs instead of sheets, resizable review pane, render flicker). User's call; this gets its own map later.
- [deferred] Tiled multi-agent panes, side chat, PR/checks loop, in-app terminal/browser, multi-model fan-out, cloud handoff. These are separate maps if wanted.
- [settled] User reads every finding presented; findings count as acknowledged at the user's next reply — user's standing call (carried from desktop map)
- [settled] User delegated all phase-1 design decisions to the agent ("surprise me"). Lines marked "agent's call" are vetoable — user
- [settled] Design direction: keep Cursor's quiet, content-first philosophy but make it less dull. User finds the reference "cool, but a bit dull".

## Findings — market research
- [settled] R1: Convergent pattern. Tool calls render as compact one-line rows, not cards. Consecutive reads/searches/web calls fold into one "Explored N…" row; edits and commands get their own rows. Acknowledged.
- [settled] R2: Cursor and Claude Code both offer a three-level density setting (Compact/Balanced/Detailed, or Summary/Normal/Verbose). Cursor users complain that "Detailed" still folds exploration calls. Acknowledged.
- [settled] R3: Thinking streams open while live and then folds to "Thought for Xs". Cursor has no keep-open option. Acknowledged.
- [settled] R4: Model and effort pickers live in the composer everywhere. Conductor adds editable queued messages. Acknowledged.
- [settled] R5: Cursor publishes no font names or sizes. Only a Text Size setting (S/M/L/XL) exists, and it covers only assistant prose. Acknowledged.

## Findings — current client
- [settled] C1: The palette is pure neutral, with zero chroma and no accent. Status colors are raw emerald/amber/red Tailwind classes (~27 occurrences), not tokens (packages/web/src/index.css). Acknowledged.
- [settled] C2: The only font is Geist Variable. There is no mono token, so code uses the browser default mono plus Shiki github-light/dark. Acknowledged.
- [settled] C3: Every tool renders in the same bordered card (wrench icon, mono name, summary). A finished tool shows no indicator. Tools are collapsed by default, with one global expand toggle in the header (tools/tool-call-view.tsx). Acknowledged.
- [settled] C4: Thinking is a native `<details>` showing italic text-xs, with no duration and no live preview. Acknowledged.
- [settled] C5: Model and thinking pickers are text-xs buttons in the status bar that open bottom sheets, desktop included (status-bar.tsx, action-sheets.tsx). Acknowledged.
- [settled] C6: The desktop transcript has no width cap (`lg:px-32`). User messages are right-aligned bubbles; assistant messages are bare prose with no per-message actions. Acknowledged.

## Findings — reference screenshots (Cursor, 2026-10-10)
- [settled] S1: Type looks like the macOS system font (SF Pro): prose at about 15px with a generous line height (~1.6) and wide paragraph spacing. Mono (SF Mono-like) is used for inline-code chips and code blocks. — acknowledged
- [settled] S2: The transcript is a centred column about 800px wide. A user message is a full-column-width tinted box with a hairline border and ~8px radius, not a bubble. Assistant replies are bare prose. — acknowledged
- [settled] S3: A finished turn's tool activity collapses entirely into one muted "Worked for 35s" line. The live state is a shimmering status phrase ("Planning next moves"), not a spinner. — acknowledged
- [settled] S4: A blue "New" divider marks where unread output begins. Each assistant message has a muted action row: thumbs up/down, copy, fork. — acknowledged
- [settled] S5: The composer is a single-line pill: "+" on the left, then the placeholder "Send follow-up", a combined model+effort picker ("Grok 4.7 High"), mic, and a round send/stop button. Under it: branch, worktree mode and a run spinner. — acknowledged
- [settled] S6: Chrome is minimal. The header is just a title chip; the right panel is plain-text nav (Changes, Browser, Terminal, Files). Backgrounds are near-black with hairline borders. The only colour is a single blue accent, used for "New" and active filters. The "dull" comes from zero colour and no icons in the transcript. — acknowledged

## Findings — code facts (2026-10-10)
- [settled] T1: pi persists `AssistantMessage.durationMs` (the whole response) and `ToolResultMessage.durationMs` (tool execution). Both are absent on legacy messages. Thinking blocks carry no timing. — acknowledged
- [settled] T2: Live events include `thinking_start`/`thinking_end`, `tool_execution_start`/`tool_execution_end` (with `durationMs`) and `agent_start`/`agent_end`, each stamped with `receivedAt`. The shared reducer `reduceLive` drops all timing (packages/protocol/src/live.ts:41-58, 262-270, 316-320). — acknowledged
- [settled] T3: Every assistant message carries `usage.cost.total`; the UI doesn't render per-message usage today. Spawn results carry their own usage. — acknowledged
- [settled] T4: There is no turn grouping. The transcript is a flat list of entries: one assistant turn is several assistant messages, and tool results render nothing (transcript.tsx:20-129). — acknowledged
- [settled] T5: Geist Mono isn't installed; it ships as a separate package, `@fontsource-variable/geist-mono`. Fonts are bundled and precached by the PWA. — acknowledged
- [settled] T6: The client knows whether a model supports reasoning (`state.model.reasoning`). Thinking levels come from an RPC per model. — acknowledged
- [settled] T7: No shimmer or custom keyframes exist; only `tw-animate-css` plus `animate-spin`/`animate-pulse`. Shiki themes are github-light/dark. — acknowledged

## A. Foundations
- [settled] A1a Fonts: Geist Sans for UI and prose, Geist Mono (new package) for code, commands and search patterns. File paths in tool rows stay in Geist Sans. Agent's call, revised after the mockup: one coherent family that's identical on every device and offline; sans paths read better in rows.
- [settled] A1b Type scale: two tiers.
  - Prose (user and assistant text) is 15px with line height 1.65.
  - UI chrome and tool rows are 13px with line height 1.4; meta and labels are 12px.
  - Code blocks are 13px mono; inline code is mono at 0.875em.
  - Markdown headings are 20, 17 and 15px semibold.
  - `text-[11px]` is removed.
  - Agent's call: prose gets air, the machinery stays dense (S1).
- [deferred] A1c Text-size setting. Agent's call: no concrete need yet; the browser's zoom already works.
- [settled] A3a Palette: pure neutral greys (zero chroma), Cursor-style. User's call after comparing five palettes in the mockup: the ink tint read as too purple/blue.
- [settled] A3b Accent: none. Liveness and actions use the foreground itself: the send button is solid foreground, the shimmer sweeps from muted to foreground, and focus rings and the active sidebar row are neutral. User's call (the "mono" palette).
- [settled] A3c Links and code-ref chips are the only hue in the chrome: a soft blue (around oklch 0.70 0.11 250 in dark mode, 0.55 0.15 250 in light), via a `--link` token. User's call: liked the links in the "graph" palette. Everything else with colour is status or diff (A2).
- [settled] A2a Status tokens: `--status-working` (neutral, the foreground shimmer), `--status-input` (amber), `--status-error` (red, i.e. destructive), `--status-done` (emerald), `--status-idle` (muted), `--diff-add` (emerald), `--diff-del` (red) and `--link` (blue). These replace the ~27 raw color classes. Agent's call (C1).
- [settled] A2b Vocabulary: Working, Needs input, Failed, Finished, Idle, Closed, used everywhere.
  - Dense lists (sidebar): a neutral spinner for Working, otherwise a colored dot. Idle is a muted dot instead of today's green, so green only ever means Finished.
  - Roomy lists (Home): the same states as icon-plus-label badges.
  - Status bar: the same words.
  - Agent's call: one meaning per color.
- [settled] A4 Transcript column: content is capped at 46rem (about 736px) and centred, on phone and desktop. The composer shares the same width. With the review pane open, the column fits the remaining space. Agent's call: keeps prose at about 80–90 characters per line; slightly narrower than Cursor's 800px because our 15px Geist is wider (S2).
- [settled] A-motion Motion:
  - One shimmer keyframe (a muted-to-foreground gradient sweeping across text, 1.6s loop).
  - A 150ms height animation when a collapsible opens or closes.
  - Under `prefers-reduced-motion` the shimmer becomes static foreground text.
  - Agent's call: accessibility; motion only signals liveness.
- [settled] A-mockup Reference mockup is /tmp/pi-code-mockup/index.html (default palette "mono"; scratch, outside the repo). The user approved its look. Agent's call.
- [settled] A-code Shiki themes are vitesse-light/vitesse-dark. Code blocks sit on a surface one step off the page, with a hairline border, 8px radius, and a header with language and copy. Inline code is a tinted chip. Agent's call: Vitesse's muted palette gives the near-monochrome UI its only warmth without shouting.

## B. Transcript
- [settled] B-user User messages render as full-width boxes, not bubbles. User's call; looks better (S2). Styling is agent's call: tinted surface, hairline border, 10px radius, 15px prose, pending at 70% opacity.
- [settled] B-turn The transcript groups entries into turns, from one user message to the next (T4). Turns are the unit for density folding (B7) and the footer (B9). Agent's call.
- [settled] B5a Tool row anatomy: a borderless single line, 28px tall, in 13px text. It contains, in order:
  - A muted 14px icon per tool.
  - A verb in the foreground color.
  - The target: the file basename in the foreground color, its directory muted; commands in mono.
  - Muted meta: line range, `+n −m` in diff colors, match count, `exit N` (only when non-zero).
  - Duration, muted, shown on hover.
  - A chevron, shown on hover.
  - Clicking expands the body: indented under the icon, inside a bordered surface. Agent's call: R1, S6.
- [settled] B5b States are carried by verb tense rather than badges. While running the verb is in the present tense with shimmer ("Reading", "Running", "Editing"); when done it's in the past tense and quiet ("Read", "Ran", "Edited"). On error the icon becomes a red alert, the verb turns red ("Edit failed"), and the first line of the error appears inline as meta. Agent's call: the tense change is the done indicator, with no extra noise.
- [settled] B5c Verbs and icons (lucide):

  | Tool | Icon | Done label |
  |---|---|---|
  | read | FileText | Read `f` :a-b |
  | bash | SquareTerminal | Ran `cmd` |
  | grep | TextSearch | Searched /p/ · N matches |
  | find | FileSearch | Found `p` · N files |
  | ls | FolderOpen | Listed `dir` · N entries |
  | edit | FilePen | Edited `f` +n −m |
  | write | FilePlus | Wrote `f` · N lines |
  | spawn | Bot | Ran N agents · progress |
  | web_search | Globe | Searched web "q" · N sources |
  | fetch_content | Link | Fetched title |
  | source_check / get_search_content | Globe | Checked / Got content |
  | mcp | Plug | server · tool |
  | generic | Wrench | tool name plus first arg |

  Agent's call.
- [settled] B5d Spawn keeps its per-agent cards inside the expanded body. Their nested tool calls render with the same row component. Agent's call: one row language everywhere.
- [settled] B5e Live-status row: this replaces "Working…" and the spinner. It's a shimmering phrase for the current activity ("Thinking", "Reading foo.ts", "Running pnpm test", "Compacting context", "Retrying 2/3 · reason") plus a muted elapsed timer. Errors keep their red alert box. It's shown only when no row above it is already shimmering, and always in Compact. Agent's call (S3); revised after the mockup showed it duplicating the running row.
- [settled] B6 Exploration grouping:
  - Consecutive read, grep, find, ls, web_search, fetch_content, source_check and get_search_content calls fold into one row: "Explored 3 files, 2 searches, 1 web search". While running it reads "Exploring · Reading foo.ts" with shimmer.
  - Thinking blocks between those calls are absorbed into the group.
  - The group breaks on visible text, edit, write, bash, spawn, mcp or other tools.
  - A failed call breaks out as its own row.
  - Agent's call: R1. Detailed density turns grouping off, which answers the R2 complaint.
- [settled] B7a Density has three levels:
  - **Compact:** in a finished turn, everything before the final assistant text (thinking, tools, intermediate text) folds into one "Worked for 2m 14s" row (S3). A live turn shows only the live-status row (B5e) and the streaming text.
  - **Balanced:** every row is visible, exploration is grouped, and everything is collapsed. Running bash and generic tools expand while active and collapse when done.
  - **Detailed:** no grouping, and every row is expanded, thinking included.
  - Agent's call.
- [settled] B7b Balanced is the default. Density is one persisted pref that replaces `toolsExpanded`. A density dropdown replaces the header's expand toggle, and Settings mirrors it. Expanding a single row still overrides locally. Agent's call.
- [settled] B8a Thinking display. While live: a "Thinking" row with shimmer and a one-line muted preview of the latest thought. When done: a "Thought for 12s" row with a muted Brain icon; expanding it shows 13px muted, non-italic text with a left hairline. Redacted blocks show "Thought (redacted)". Agent's call (R3).
- [settled] B8b Timing is recorded in `reduceLive`:
  - `startedAt` and `endedAt` on streaming blocks.
  - `startedAt` and `durationMs` on tool runs.
  - `startedAt` on the run itself.
  - All are taken from `receivedAt`, so they also survive a reload mid-run.
  - Committed tools use `toolResult.durationMs`.
  - Agent's call (T1, T2).
- [settled] B8c Thinking durations live in the shared live state (`thinkingMs`, keyed by message timestamp and content index), so they survive commit and reloads while the pi process lives. After a process or server restart, and in history, a block reads "Thought" with no duration. Agent's call: without it, "Thought for 12s" would drop to "Thought" seconds later, when the message commits; persisting a timing entry is out of scope.
- [settled] B9a Turn footer: one muted 12px line under a finished turn: "3m 12s · $0.14 · 4 files +120 −30".
  - Duration runs from the user message timestamp to the last assistant message's timestamp plus `durationMs`.
  - Cost is the sum of `usage.cost.total` across the turn, plus spawn usage (T3).
  - File counts come from the edit and write details.
  - Compact density drops the duration, since the "Worked" row already shows it.
  - Agent's call.
- [settled] B9b The files chip opens the review pane on desktop and the diff route on phone. Agent's call: it reuses existing surfaces. The pane shows the working tree, not a per-turn diff, which is an accepted limitation.
- [settled] B9c Message actions: copy (the turn's final text, as markdown) appears in the footer on hover on desktop and always on touch. No thumbs (there's no backend for them) and no fork button (fork stays in the kebab menu). Agent's call: only actions that already work.
- [settled] B10 One collapsible component, built on Radix Collapsible, with a row trigger and the 150ms animation. Tool rows, groups, thinking, the "Worked" row and attachments all use it; native `<details>` goes away. Agent's call.

## C. Composer
- [settled] C11a Layout: the composer box keeps its auto-growing textarea, with a footer row inside the box.
  - Left: attach, as a "+" icon instead of today's paperclip.
  - Right: the model-and-thinking picker, then the round send button in solid foreground.
  - Agent's call (S5).
- [settled] C11b Picker: one combined button ("Opus 5 · High") in 13px muted text with a chevron.
  - Desktop: a popover with a searchable cmdk model list grouped by provider, and a thinking-level segmented control at the bottom, shown only for reasoning models (T6).
  - Phone: the existing bottom sheets.
  - Agent's call: R4, S5.
- [settled] C11c Status bar keeps folder, branch and dirty dot, the context bar, cost and the run indicator. Model and thinking move out of it. Agent's call.
- [settled] C11d Running state: Stop is always visible, as a round neutral surface with a hairline border and a square icon. When the draft is non-empty, Steer (round, solid foreground) and a small text "Queue" button appear. Steer/queue behavior and keys are unchanged. Agent's call, revised after the mockup: a solid Stop out-weighed Steer.
