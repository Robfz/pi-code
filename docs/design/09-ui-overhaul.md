# UI overhaul (phase 1)

The web client's look and feel: tokens, typography, motion, the transcript (turns, tool rows, thinking, exploration groups, density), the composer and its model picker. Decisions and rationale: [`../../maps/2026-10-10-ui-overhaul.md`](../../maps/2026-10-10-ui-overhaul.md). Where this document overlaps `03-web-client.md` or `05-desktop.md`, it takes precedence.

The approved reference is the mockup [`mockups/ui-overhaul.html`](mockups/ui-overhaul.html) (open it in a browser; its controls switch theme, density, the live turn's activity, the picker and a phone frame). Where the mockup and this document differ, this document wins: the mockup always shows the live-status row, and its chrome without a map decision (the header's diffstat label, the sidebar's brand mark, group counts and connection footer) isn't part of phase 1.

## Tokens

The default palette, neutral, is the mockup's: neutrals have zero chroma and there is no accent hue. Liveness and actions use the foreground itself: the send button is solid foreground, the shimmer sweeps from muted to foreground, focus rings and the active sidebar row are neutral. The only hue in the chrome is `--link`; every other colour is status or diff. The other palettes ([Palettes](#palettes)) recolour the same tokens.

`src/index.css` sets shadcn's variables to the mockup's values and adds the variables shadcn lacks (marked *new*), each exposed to Tailwind through `@theme inline` (`--color-<name>: var(--<name>)`). The tables below are neutral's values.

### Neutrals

| Role | Variables | Light | Dark |
|---|---|---|---|
| Page | `--background` | `oklch(0.992 0 0)` | `oklch(0.16 0 0)` |
| Sidebar | `--sidebar` | `oklch(0.975 0 0)` | `oklch(0.145 0 0)` |
| Surface: code blocks, tool bodies, composer | `--card` | `oklch(0.972 0 0)` | `oklch(0.188 0 0)` |
| Raised surface: Stop button, selected segment | `--secondary`, `--muted` | `oklch(0.95 0 0)` | `oklch(0.215 0 0)` |
| Popover | `--popover` | `oklch(1 0 0)` | `oklch(0.2 0 0)` |
| User message | `--user-message` *new* | `oklch(0.966 0 0)` | `oklch(0.2 0 0)` |
| Hover | `--accent` | `oklch(0.3 0 0 / 0.05)` | `oklch(0.96 0 0 / 0.045)` |
| Active sidebar row | `--sidebar-accent` | `oklch(0.55 0 0 / 0.09)` | `oklch(0.7 0 0 / 0.13)` |
| Hairline | `--border`, `--sidebar-border` | `oklch(0.3 0 0 / 0.11)` | `oklch(0.96 0 0 / 0.085)` |
| Strong hairline: composer, popovers, inputs, thinking rule | `--input` | `oklch(0.3 0 0 / 0.17)` | `oklch(0.96 0 0 / 0.14)` |
| Chip: inline code, segmented track | `--chip` *new* | `oklch(0.3 0 0 / 0.065)` | `oklch(0.96 0 0 / 0.075)` |
| Foreground | `--foreground` and every `--*-foreground` above | `oklch(0.21 0 0)` | `oklch(0.93 0 0)` |
| Secondary text: commands, sidebar rows | `--subtle-foreground` *new* | `oklch(0.32 0 0)` | `oklch(0.82 0 0)` |
| Muted: meta, labels | `--muted-foreground` | `oklch(0.49 0 0)` | `oklch(0.66 0 0)` |
| Faint: row icons, directories, timers, placeholders | `--faint-foreground` *new* | `oklch(0.63 0 0)` | `oklch(0.5 0 0)` |
| Solid foreground: Send, Steer | `--primary`, `--sidebar-primary` / `--primary-foreground` | `oklch(0.21 0 0)` / `oklch(0.992 0 0)` | `oklch(0.93 0 0)` / `oklch(0.16 0 0)` |
| Focus ring | `--ring`, `--sidebar-ring` | `oklch(0.49 0 0)` | `oklch(0.66 0 0)` |

### Colour

| Token | Meaning | Light | Dark |
|---|---|---|---|
| `--link` *new* | Links, line references | `oklch(0.55 0.15 250)` | `oklch(0.7 0.1125 250)` |
| `--status-working` *new* | Working (neutral) | `var(--foreground)` | `var(--foreground)` |
| `--status-input` *new* | Needs input | `oklch(0.72 0.16 65)` | `oklch(0.8 0.15 75)` |
| `--status-error` *new*, `--destructive` | Failed, errors | `oklch(0.58 0.21 25)` | `oklch(0.69 0.19 22)` |
| `--status-done` *new* | Finished | `oklch(0.62 0.14 160)` | `oklch(0.76 0.15 160)` |
| `--status-idle` *new* | Idle | `var(--faint-foreground)` | `var(--faint-foreground)` |
| `--status-online` *new* | Connection live (the header's dot only) | `oklch(0.66 0.17 145)` | `oklch(0.74 0.17 145)` |
| `--diff-add` *new* | Added lines, `+n` | `var(--status-done)` | `var(--status-done)` |
| `--diff-del` *new* | Deleted lines, `−m` | `var(--status-error)` | `var(--status-error)` |

Tints use Tailwind opacity modifiers, not more tokens: diff line backgrounds `bg-diff-add/10` and `bg-diff-del/10`, the line-reference chip `bg-link/12`, the composer's selection `selection:bg-link/25`.

No component uses raw palette classes (`emerald-*`, `amber-*`, `red-*`, `green-*`, `blue-*`, `sky-*`); colour comes from these tokens:

| Where | Token |
|---|---|
| Edit and review `+n −m`, diff viewer line backgrounds, review "A" | `diff-add` / `diff-del` |
| Review "M", the status bar's and the activity rail's dirty dots, the context bar from 60% | `status-input` (as in the mockup) |
| The context bar from 80% | `status-error` |
| Review "R", the tree's user marker | `muted-foreground`, `foreground` |
| Subagent card "done" | `status-done` |
| Line references (`CODE_REF_COLOR`), links in tool bodies | `link` |
| Sidebar marks, Home badges, `/sessions` badges, attention | the status vocabulary (below) |
| Connection indicator | live: `status-online` dot; connecting, reconnecting: pulsing `status-idle` dot with its label; offline: `status-error` dot with its label |

### Syntax

Code blocks and the diff viewer share ten tokens: `--syntax-fg`, `-keyword`, `-string`, `-function`, `-comment`, `-number`, `-property`, `-variable`, `-type`, `-punctuation`. Neutral's are Vitesse Light / Dark.

### Palettes

Two independent choices, both in Settings: the theme (System, Dark, Light; next-themes puts `.dark` on `<html>`) and the palette, persisted as `palette` in `store/ui-prefs.ts` (`lib/palettes.ts`). Every palette has a light and a dark variant, so System keeps working.

| Palette | Light / dark | Primary, ring | Ultraspawn |
|---|---|---|---|
| Neutral (default) | the tables above | foreground | purple |
| macOS | system Light / Dark | systemBlue (fill deepened to selectedContentBackground) | systemPurple |
| Catppuccin | Latte / Mocha | mauve | pink |
| Nord | Snow Storm / Polar Night | frost (nord10 / nord8) | nord15 |
| Tokyo Night | Day / Night | blue | magenta |
| Abyss | Shallows / the deep | deep teal / bioluminescent cyan | jellyfish violet |
| Aurora | Polar day / Arctic night | spruce / aurora green | aurora magenta |
| Sumi | ink on washi / washi on ink stone | ai (indigo) | murasaki |
| Sakura | blossom / yozakura | sakura pink | wisteria |

Abyss, Aurora, Sumi and Sakura are our own designs; the others follow published themes.

- **Where.** `data-palette` on `<html>`, set by the app and, before first paint, by an inline script in `index.html` reading the saved preference. Palettes other than neutral live in `src/palettes.css`, imported after `index.css`. Selectors match `<html>` or any element inside it, so the Settings swatches (dots in `primary`, `link`, `status-done`, `ultraspawn` inside their own `data-palette`) show each palette's colours without repeating them. The installed app's title bar follows the page's `--background` (`lib/theme-color.ts`, [web client](03-web-client.md)). A palette's dark block sets every token its light block does: the light block ties with neutral's `.dark` in specificity and wins by order.
- **Surfaces** keep neutral's elevation: the sidebar sits below the page in dark and just under it in light, cards one step off the page, popovers above it; hover, hairlines, inputs, chips and the scrollbar are the palette's text colour at neutral's opacities. macOS follows the system instead: hue-free greys (page `#FFFFFF` / `#1E1E1E`), a sidebar darker than the page in light and lighter in dark, text at AppKit's label alphas flattened onto the page, and hairlines at its separator alpha (black / white at 0.1). The original palettes tint every surface faintly: Abyss seafoam / abyssal navy-teal (hue ≈200 / 226), Aurora snow / night sky (blue-violet, ≈275 / 280), Sumi warm washi / ink stone (≈85, near-grey), Sakura blossom-white / plum-black (≈355 / 350).
- **Accents.** Neutral stays monochrome. macOS fills `--primary` with systemBlue deepened to selectedContentBackground (`#0063E1` / `#0058D0`) so white text reads on it, and rings with systemBlue itself (`#0088FF` / `#0091FF`). The others tint `--primary`, `--ring` and `--sidebar-primary` with their signature colour, with `--primary-foreground` from the palette's base. Semantics hold across palettes: needs input is yellow (systemOrange in macOS), errors red, done green or teal, online green, links blue or cyan, ultraspawn purple or pink. The original palettes keep the link off the primary: azure under Abyss's cyan, ice blue under Aurora's green, hanada (pale indigo-blue) under Sumi's ai, spring sky under Sakura's pink; Sumi names its semantics after dyes (shu errors, matcha done, kincha needs input), Sakura's needs input is lantern amber.
- **Syntax** follows each palette's own editor theme (Catppuccin: mauve keywords, green strings, blue functions; Nord: nord9 keywords, nord14 strings, nord8 functions; Tokyo Night: magenta keywords, green strings, blue functions). macOS instead takes Apple's cool system colours, softened for code and with no warm hues: indigo keywords, lavender-purple types, mint strings, teal properties, cyan functions, blue numbers, a slate-grey comment, plain text for variables and the secondary label grey for punctuation. The original palettes: Abyss violet keywords, aqua types, sea-green strings, azure-cyan functions, coral numbers (its one warm hue), steel-blue properties, slate-teal comments; Aurora only the aurora's hues (violet keywords, magenta types, green strings, teal functions, ice-blue numbers and properties); Sumi mostly ink with muted dyes (ai keywords, murasaki types, matcha strings, kincha properties, iron-teal functions, shu numbers); Sakura pink keywords, wisteria types, leaf-green strings, sky functions, amber numbers, dusty-plum properties. Keyword / type, string / property and function / number stay at least 0.08 apart in OKLab.
- **Contrast.** Values start from each palette's official colours (the originals' own picks); lightness moves where needed so that text, muted and subtle text, links, errors and syntax reach 4.5:1 on the page and on cards (comments 3:1), and faint text matches neutral's ratio (about 3.4:1 light, 3.2:1 dark). Where a palette's body text sits near 4.5:1 (Tokyo Night Day), it moves to about 6:1 so muted and subtle text fit under it.

## Typography

Geist Sans (`@fontsource-variable/geist`) for UI and prose; Geist Mono (`@fontsource-variable/geist-mono`) for code, commands and search patterns. File paths in tool rows are sans. Text renders with grayscale antialiasing (`antialiased` on `body`). Both are bundled and precached by the service worker (the `woff2` precache glob), so text looks the same on every device and offline.

```css
--font-sans: "Geist Variable", ui-sans-serif, system-ui, sans-serif;
--font-mono: "Geist Mono Variable", ui-monospace, monospace;
```

| Use | Size / line height | Utility |
|---|---|---|
| Prose: user and assistant text, the composer's textarea | 15px / 1.65 | `text-prose` (`--text-prose`) |
| Markdown h1 / h2 / h3 | 20px / 1.35, 17px / 1.4, 15px / 1.5, semibold | markdown styles |
| UI chrome, tool rows | 13px / 1.4 | `text-sm` (`--text-sm` redefined in `@theme`) |
| Meta, labels | 12px | `text-xs` |
| Code blocks | 13px mono / 1.6 | markdown styles |
| Inline code | mono, 0.875em | markdown styles |

`text-[11px]` doesn't occur. Paragraphs are spaced 0.8em; list markers are faint.

## Motion

- **Shimmer.** One utility, `shimmer`: a `background-clip: text` gradient (`muted-foreground` 0–40%, `foreground` 50%, `muted-foreground` 60–100%, 300% wide) sweeping across the text in a 1.6s linear loop. It marks live text only: running verbs, the live-status phrase, "Thinking", "Exploring".
- **Collapsible.** Opening and closing animates the height in 150ms (`tw-animate-css`'s `collapsible-down` / `collapsible-up` on `--radix-collapsible-content-height`); the chevron rotates 90° in the same time.
- **Reduced motion.** Under `prefers-reduced-motion: reduce` the shimmer is static `foreground` text and collapsibles open without animation.
- Spinners are neutral (`muted-foreground`), used only for Working in dense lists and the status bar.

## Code and links

- Shiki highlights with one theme for light and dark (`lib/code-highlighter.ts`) whose colours are the `--syntax-*` tokens as `var()` strings, its scopes following Vitesse's; switching palette or theme restyles code without highlighting again. The diff viewer (`components/diff/diff-theme.css`) maps highlight.js classes onto the same tokens, on `--card` rows with hairline borders and `diff-add` / `diff-del` tints; wrapped diff lines break between words where they can.
- Code blocks (Streamdown's `[data-streamdown="code-block"]`) sit on `--card` with a hairline border and 8px radius, under a 32px header holding the language (12px muted) and a copy button; the body is 13px mono, line height 1.6, scrolling horizontally.
- Inline code is a mono chip: 0.875em on `--chip`, 5px radius.
- Links are `text-link`, underlined on hover.
- Line references in assistant text are mono chips in `text-link` on `bg-link/12`; in user messages and the composer's mirror they are `text-link` text (the mirror must keep the textarea's metrics).

## Layout

The transcript and the composer area share one column: `mx-auto w-full max-w-[46rem]` (736px), with `px-4` below 1024px and `px-6` from 1024px, on phone and desktop alike. With the review pane open the column fits the space left beside it. The header spans the full width up to the activity rail. Turns are 40px apart.

On desktop the activity rail is a 44px column at the right edge (`border-l` hairline on `--background`): an empty cell the height of the header row, then 32px ghost icon buttons (Changes, Files, Tree) in `muted-foreground`; the one whose tab the review pane shows sits on `--sidebar-accent` in `foreground`, like the active sidebar row. Tooltips open to the left. Details in [`07-code-review.md`](07-code-review.md), "Desktop pane".

### Conversation outline

On desktop, `ConversationOutline` (`features/conversation/conversation-outline.tsx`) lists the conversation's prompts in the transcript's right margin, like a docs site's "On this page":

- **Items:** one button per prompt of the active branch, the pending one last: the first non-blank line of its text after attached `<file>` blocks (`promptTitle`), 12px `muted-foreground`, truncated with the line as `title`. Prompts without text (images only) are left out; with fewer than two items there is no outline. No heading.
- **Look:** 14rem wide, 1rem past the column's outer edge, behind a left `--border` hairline. The current item is `foreground` with a `foreground` accent on the hairline; the others turn `foreground` on hover.
- **Placement:** absolutely positioned beside the transcript column, inside the scroller, so the wheel over it scrolls the transcript. It sticks 2rem below the scroller's top and is at most the scroller's height less 4rem (`100cqh`), scrolling on its own past that and keeping the current item in view.
- **When:** the scroller is a size container on desktop (`@container-size`) and the outline shows from 78rem of its width (`@min-[78rem]`), where the margin holds it beside the 46rem column; so the review pane, by narrowing the transcript, hides it. Not rendered on phone: containment would make the scroller the containing block of the phone's fixed selection bar.
- **Current:** the last prompt whose top is above a third of the scroller's height; once scrolled to the end, the last one whose top is in view. A passive scroll listener and a `ResizeObserver` on the scroller measure in an animation frame, skipped while the outline is hidden (`checkVisibility()`), binary-searching the prompts' tops (`data-prompt-id` on each user message).
- **Jump:** a click smooth-scrolls (instantly under reduced motion) so the prompt's top sits 16px below the scroller's top, through `useStickToBottom`'s `scrollTo`: an upward jump stops following live at once, as a scroll up does; a jump that stays at the bottom keeps following.
- **Accessibility:** `<nav aria-label="Conversation outline">` holding a list of buttons; the current one has `aria-current="true"`.

## Status vocabulary

One word and one colour per state, everywhere. Among agent states green is only Finished (`status-done`); the connection's own green, `status-online` (a purer, yellower hue), marks the header's live dot and nothing else. `agentStatus(agent, pending)` (`lib/agent-status.ts`) takes the first match:

| Status | When | Colour | Sidebar mark | Home badge icon |
|---|---|---|---|---|
| Needs input | `attention: "input"`, or `status: "awaiting_trust"` | `status-input` | dot | `MessageCircleQuestion` |
| Working | the row's resume or restart is in flight, `status: "starting"`, or `isStreaming` | `status-working` | spinner | spinner |
| Failed | `attention: "failed"` | `status-error` | dot | `CircleX` |
| Finished | `attention: "finished"` | `status-done` | dot | `CircleCheck` |
| Closed | no agent (a session row), or `status: "exited"` | — | none | `CircleDashed` (muted) |
| Idle | otherwise: pi runs, nothing to report | `status-idle` | dot | `Circle` (muted) |

`components/agent-status.tsx` renders it:

- **`StatusMark`** (sidebar, dense): the spinner or a 7px dot, labelled with the word (`aria-label` and `title`); it is the row's only status or attention mark. A collapsed sidebar group's header shows its hidden rows' marks ([`05-desktop.md`](05-desktop.md), "Sidebar").
- **`StatusBadge`** (Home, roomy): icon plus the word. Home's agent rows show one badge; recent-session rows on Home and `/sessions` held by an agent show that agent's badge.
- **Status bar** (below 640px): "Working" with a spinner while the run is active, compacting or retrying; nothing otherwise.
- **Conversation header** (from 640px): "Working · 2m 13s" in `shimmer` beside the connection dot in the same cases, timed from the run's `agent_start` (`selectWorking`, `selectRunStartedAt`).

## Transcript

### Turns

The transcript is a list of turns. `selectTurns` (`store/turns.ts`, memoized on the active branch) splits the active branch at each user message; entries before the first one form a turn without a user message.

```ts
interface Turn {
  id: string;                 // the user entry's id; "start" for the leading turn
  user?: UserMessageEntry;
  steps: Step[];
}

type Step =
  | { kind: "text"; key: string; text: string }            // non-empty assistant text block
  | { kind: "thinking"; key: string; text: string; redacted: boolean; startedAt?: number; endedAt?: number }
  | { kind: "tool"; key: string; toolCallId: string; toolName: string; args: unknown }
  | { kind: "stop"; key: string; message: AssistantMessage } // error, aborted or truncated notice
  | { kind: "entry"; key: string; entry: SessionEntry };    // anything else entryView describes
```

- Tool results produce no step; `ToolCallSlot` pairs each call with its result by `toolCallId`.
- `entryView(entry)` (`transcript/entry-view.ts`) says which other entries show and as what (`!cmd` runs, displayed custom messages, compaction and branch summaries, model and thinking level changes); `selectTurns` makes their steps and `renderEntry` renders them from it.
- A rebuilt turn whose entries are the same objects as before keeps its identity, so a commit re-renders only the turn it lands in.
- **The live turn** is the last turn while `live.run.active`. Its steps (`useLiveSteps`, `transcript/live-steps.ts`) continue with the streaming message's blocks (thinking blocks carrying `startedAt` / `endedAt`, tool calls with their raw `argsText`) and the orphan tool runs. A `pendingUser` starts a new live turn with that message at 70% opacity. Committed turns render as memoized `TurnView`s; only the live turn subscribes to live state, so token deltas re-render only it.
- **The final text** is the run of text steps after the turn's last thinking or tool step. A turn ending in a tool call has none.
- `!cmd` runs in flight render after the turns. A `!cmd` row shows its command, then its exit code when non-zero (`status-error`).

### User message

A full-column-width box: `--user-message` surface, 1px hairline, 10px radius, 11px × 15px padding, 15px prose. Image thumbnails and attached-file chips sit inside it. Assistant replies are bare 15px prose.

### Collapsible

`CollapsibleRow` (`components/collapsible-row.tsx`), on Radix Collapsible (`components/ui/collapsible.tsx`), is the transcript's only disclosure; the sidebar's group headers use the same Radix Collapsible and motion ([`05-desktop.md`](05-desktop.md), "Sidebar"); `<details>` doesn't occur.

- **Trigger:** a borderless 28px row, the full column width with an 8px hover bleed (`-mx-2 px-2`, `hover:bg-accent`, 7px radius): a 14px icon slot, the label, then a tail (duration and chevron) shown on hover, on focus, and while open.
- **Content:** animated as in Motion; bodies are indented 22px (icon plus gap) so they align under the verb, and not indented below 1024px.
- A row without a body has no chevron and doesn't toggle.
- Users: tool rows, exploration groups, thinking, the "Worked" row, user attachments, summary dividers, `!cmd` output, and the sub-sections inside tool bodies (web results, subagent output, generic arguments, MCP results, custom messages).

### Tool rows

`ToolRow` (`tools/tool-row.tsx`) renders every tool call, nested subagent calls included:

```
[icon] Verb  target  meta                                  1.2s ›
```

- **Icon:** 14px lucide, `faint-foreground`.
- **Status:** `toolStatus` (`store/tool-status.ts`): the committed result's, else the live run's, else streaming while the assistant streams the arguments. A call with none of these is running while the run is active if it's in the live turn (the branch's last turn, or the streaming message once a pending user message starts a new one); one left unanswered in an earlier turn (an aborted message) is done. Exploration groups and the live-status row use the same function.
- **Verb:** weight 500, `foreground`. Running or streaming: present tense with `shimmer`. Done: past tense, quiet. Failed: the icon becomes `CircleAlert` and the verb turns `status-error` ("Edit failed").
- **Target:** a path is its basename in `foreground` followed by its directory in `faint-foreground` (directory hidden below 1024px; relative to the conversation's folder when inside it); a command or pattern is mono 12.5px `subtle-foreground`; other text is `foreground`. Truncated with an ellipsis.
- **Meta:** `muted-foreground`, tabular numbers; `+n −m` in diff colours. A failed call appends the first line of its error.
- **Duration:** `faint-foreground` 12px in the tail: committed calls use `toolResult.durationMs`, live ones `ToolRun.durationMs`, running ones the elapsed time since `ToolRun.startedAt`; none when unknown.
- **Body:** the renderer's `Body` in a bordered `--card` surface, 8px radius, without nested boxes. `read` code and `edit` / `write` diffs fill it edge to edge (no inner frame or header; the copy button shows on hover); `bash` is one terminal surface: the command after a faint `$`, the output in `subtle-foreground`, then `exit N` (faint, `status-error` when non-zero). A finished call with neither a result nor a partial result (never executed) has no body. A call with a curator URL shows its Review button under the row while collapsed.

Each renderer describes its row through `label()`:

```ts
interface ToolLabel {
  icon: LucideIcon;
  verb: string;                                       // from props.status
  target?: { kind: "path" | "code" | "text"; text: string };
  meta?: ReactNode;
}

interface ToolRenderer {
  label(props: ToolRendererProps): ToolLabel;
  Body: ComponentType<ToolRendererProps>;
  /** Balanced: expanded while running. bash and the fallback renderer only. */
  expandWhileRunning?: boolean;
}
```

| Tool | Icon | Running | Done | Failed | Target | Meta |
|---|---|---|---|---|---|---|
| `read` | `FileText` | Reading | Read | Read failed | path | `:a-b` when `offset`/`limit` are given |
| `bash` | `SquareTerminal` | Running | Ran | Command failed | command, first line | `exit N` when non-zero |
| `grep` | `TextSearch` | Searching | Searched | Search failed | `/pattern/` | `· N matches` |
| `find` | `FileSearch` | Finding | Found | Find failed | pattern | `· N files` |
| `ls` | `FolderOpen` | Listing | Listed | List failed | directory path | `· N entries` |
| `edit` | `FilePen` | Editing | Edited | Edit failed | path | `+n −m` |
| `write` | `FilePlus` | Writing | Wrote | Write failed | path | `· N lines` |
| `spawn` | `Bot` | Running | Ran | Agents failed | `N agents` | progress (`step 2 running`, `2/3 done`…) |
| `web_search` | `Globe` | Searching web | Searched web | Web search failed | `"query"`, or `N queries` | `· N sources` |
| `fetch_content` | `Link` | Fetching | Fetched | Fetch failed | the page title, else the URL, or `N URLs` | |
| `source_check` | `Globe` | Checking | Checked | Check failed | the claim | `· N sources` |
| `get_search_content` | `Globe` | Getting content | Got content | Get content failed | title, URL or selector | |
| `mcp` and MCP namespace tools | `Plug` | Calling | Called | Call failed | `server · tool` (mono) | |
| anything else | `Wrench` | tool name | tool name | `<name>` failed | first string argument | |

`spawn` keeps its per-agent cards in the body; each card's nested tool calls are `ToolRow`s without a body, labelled from their arguments and, when the agent's messages hold their result, its state.

### Thinking

- **Live** (a streaming block not yet done): a `Brain` row reading "Thinking" with `shimmer`; while collapsed, one faint line under it shows the latest line of the thought, truncated.
- **Done:** "Thought" with the muted meta "for 12s" when the duration is known: the streaming block's `startedAt` and `endedAt`, else `thinkingMs` for a committed block (whole seconds, at least 1s; `1m 4s` from a minute). Otherwise "Thought".
- **Body:** 13px `muted-foreground`, line height 1.6, not italic, behind a left `--input` hairline.
- **Redacted:** "Thought (redacted)", no body. An empty, finished block renders nothing.

### Exploration groups

`groupSteps(steps)` (`features/conversation/transcript/grouping.ts`) folds exploration into one row:

- **Exploration calls:** `read`, `grep`, `find`, `ls`, `web_search`, `fetch_content`, `source_check`, `get_search_content`.
- Two or more consecutive exploration calls form a group, with the thinking steps between two of them. A lone call stays a plain row; thinking before the first call or after the last stays outside.
- Anything else ends the group: visible text, any other tool (`edit`, `write`, `bash`, `spawn`, `mcp`, others), entries and stop notices. A failed exploration call breaks out as its own row.
- **Done:** `Telescope` icon, "Explored" with the muted meta "3 files, 2 searches, 1 web search": `read` counts files, `grep` and `find` searches, `ls` listings, `web_search` and `source_check` web searches, `fetch_content` and `get_search_content` pages; zero counts are left out.
- **Running** (a child running or streaming): "Exploring · Reading foo.ts" with `shimmer`, from the running child's verb and short target (basename, pattern or query).
- The body holds the children's rows. A collapsed group shows its children's curator Review buttons under it. The group's key is its first child's, so it keeps its open state while it grows.

### Density

One persisted preference, `density: "compact" | "balanced" | "detailed"` (`store/ui-prefs.ts`, storage key `pi-code:ui-prefs`, version 1), default Balanced. Version 0's `toolsExpanded: true` migrates to Detailed, `false` to Balanced.

| | Compact | Balanced | Detailed |
|---|---|---|---|
| Finished turn | User message; one "Worked for 2m 14s" row (collapsed) holding the turn's thinking, tool and non-final text steps; the final text and the remaining steps; footer | Every step; exploration grouped; every row collapsed | Every step; no grouping; every row expanded, thinking included |
| Live turn | User message, the streaming text, the live-status row | As finished; running `bash` and fallback-renderer rows expanded while running, collapsed when done | As finished |
| Footer | Without the duration | Full | Full |

- **"Worked" row:** `ListChecks` icon, the verb in `muted-foreground` at weight 450, the turn duration (see Turn footer; "Worked" alone without one). Expanded, it shows the folded steps as Balanced does. A turn with nothing to fold has no "Worked" row.
- **Local override:** toggling a row keeps its state until the density changes, which resets every row.
- **Header:** a density dropdown: `ListCollapse` icon, the current level's name (from 1024px) and a chevron. The menu, "Transcript density", lists Compact ("Finished turns fold into ‘Worked for …’"), Balanced ("Every step, exploration grouped") and Detailed ("No grouping, everything expanded"), the current one checked.
- **Settings:** a "Transcript density" section with the same three choices.

### Live-status row

The last line of the live turn: a `shimmer` phrase and a faint elapsed timer, "Running pnpm test · 42s". It shows while the run is active or a compaction or retry is pending, and:

- in Compact, always;
- in Balanced and Detailed, only when no row above shimmers: no tool call running or streaming (by `toolStatus`), and no live thinking block.

The phrase is the first match of: "Compacting context"; "Retrying 2/3 · {errorMessage}"; "Thinking" (a live thinking block); the running tool's present verb and short target ("Reading foo.ts"); "Working". `selectLiveActivity` (`store/tool-status.ts`) picks the case, with the running call for the tool case; `LiveStatusRow` words it through the tool renderers. The timer counts from `live.run.startedAt`, every second, and is absent without it. A run error keeps its red alert box under the turn.

### Turn footer

One 12px `faint-foreground` line under each finished turn with an assistant message (never the live turn), its parts joined by `·`:

- **Duration** (not in Compact): from the user message's `timestamp` to the last assistant message's `timestamp + durationMs` (`durationMs` counted as 0 when absent). Absent without a user message.
- **Cost:** the sum of the turn's assistant `usage.cost.total` plus its `spawn` results' usage (`subagentCost`), formatted as the status bar's cost.
- **Files chip:** a bordered 22px chip, `GitCompare` icon, "4 files +120 −30": the distinct paths of the turn's successful `edit` (counts from `details.patch`) and `write` (line count as additions) calls; absent without any. It opens the review pane's Changes tab on desktop (`openPane(agentId, "changes")`) and `/agents/$agentId/diff` on phone.
- **Copy:** copies the final text as markdown (text blocks joined by a blank line); shown on hover and focus where the pointer can hover, always on touch; absent without final text.

## Composer

```
┌ composer ─────────────────────────────────────────────────────────┐
│ attachments                                                       │
│ textarea (15px, auto-growing)                                     │
│ (+)                          Opus 5 · High ⌄   Queue  (■)  (↑)    │
└───────────────────────────────────────────────────────────────────┘
  folder  ⎇ branch ●                     ▮▮▯▯▯ 38%   $1.24   ◌ Working
```

- **Box:** `--card`, `--input` hairline, 16px radius; focused: `ring`-coloured border at 50% and a 3px `ring/15` halo. The footer row sits inside the box.
- **Left:** attach, a ghost round 30px `Plus` button ("Attach file").
- **Idle, right:** the picker, then Send: round 30px, solid foreground (`bg-primary`), `ArrowUp`; on `--chip` with a faint icon while disabled.
- **Running, right:** the picker, then, while the draft has text or attachments, a small text "Queue" button (28px, `--input` hairline, 13px muted) and Steer (round, solid foreground, `ArrowUp`); Stop is always there, between them: round, `--secondary` with an inset `--input` hairline, a 10px square.
- **Stop & edit** sits at the end of the queue display while the queue is non-empty.
- Steer sends `prompt` with `streamingBehavior: "steer"`, Queue with `"followUp"`, Stop `abort`, Stop & edit `clear_queue` then `abort` (restoring the queued texts). Keys: Enter sends (steers while running), Alt+Enter queues, Shift+Enter is a newline, Enter is a newline on touch.
- **Prompt history:** Up with the caret at the start of the text recalls the previous prompt of the active branch (`selectPromptHistory`: user text without `<file>` blocks, bash commands as `!cmd` / `!!cmd`, consecutive duplicates collapsed), caret at its start; Down with the caret at the end recalls the next one, caret at its end, and past the newest restores the draft from before browsing (`Draft.browse`). Elsewhere in the text the arrows move the caret natively first. Edits to a recalled prompt are dropped on the next step; the slash menu takes the arrows while open.

### Model picker

`ModelPicker` (`features/conversation/model-picker.tsx`): one button, `{model name} · {level}` ("Opus 5 · High"; "No thinking" for `off`; the model name alone for models without `reasoning`), 13px muted with a chevron, disabled until pi is ready.

- **Desktop:** a 300px popover above the button, aligned to its end: a searchable cmdk list ("Search models") of `get_available_models` grouped by provider (`groupModels`), the current model checked; choosing one sends `set_model` and closes. For reasoning models, a "Thinking" segmented control of `get_available_thinking_levels` sits at the bottom; choosing a level sends `set_thinking_level` and keeps the popover open. Escape closes.
- **Phone:** the button opens the model bottom sheet, which shows the same thinking segmented control at its bottom for reasoning models.
- `/model` and `/thinking` keep their sheets.

### Status bar

12px `faint-foreground`, one line: folder (from 1024px), branch with the dirty dot, then on the right the context bar with its percentage (from 1024px), the cost with `(sa $x)`, and Working; extension `setStatus` chips below. The context bar and cost open the stats sheet. The session name (in the header), the model and the thinking level (in the picker) aren't in it.

## Protocol: timing in `reduceLive`

`reduceLive` records timing from the pi event's `receivedAt` (the server's clock), so snapshots carry it and a reload mid-run keeps it; without `receivedAt` the fields stay absent.

```ts
type StreamingBlock =
  | { type: "text"; text: string; done: boolean; startedAt?: number; endedAt?: number }
  | { type: "thinking"; text: string; done: boolean; startedAt?: number; endedAt?: number }
  | { type: "toolCall"; id: string; name: string; argsText: string; call?: ToolCall; startedAt?: number; endedAt?: number };

interface ToolRun {
  // …
  startedAt?: number;   // tool_execution_start
  durationMs?: number;  // tool_execution_end
}

interface LiveRun {
  // …
  startedAt?: number;   // agent_start
}

interface LiveState {
  // …
  /** Thinking durations by thinkingKey(assistantMessage.timestamp, contentIndex), the latest 500; outlives runs. */
  thinkingMs: Record<string, number>;
}
```

- **Blocks:** `startedAt` when the block is created (its `*_start`, or the delta that creates it), kept through deltas; `endedAt` at its `*_end`.
- **Tool runs:** `startedAt` at `tool_execution_start`, kept through updates and the end; `durationMs` at `tool_execution_end`, from the event's `durationMs`, else `receivedAt − startedAt`.
- **Run:** `startedAt` at `agent_start`; settling drops it with the rest of the run.
- **Thinking durations:** at `thinking_end`, `endedAt − startedAt` is stored in `thinkingMs` under `thinkingKey(timestamp, contentIndex)` (exported by `@pi-code/protocol`: `"${timestamp}:${contentIndex}"`) of the streaming message and the block. Settling keeps it, so a committed block looks up its duration by the same key from its message's `timestamp` and its index in `content` (the web's step keys are built with it too). It keeps the latest `MAX_THINKING_DURATIONS` (500) entries, dropping the oldest by insertion order, and lives as long as the agent's live state on the server: reloads keep it, and only a restart of the pi process or the server loses it.
- The web store fills fields a snapshot lacks from `initialLiveState()` on hydrate, so a client newer than the server it talks to still gets every field.
- Committed calls use `ToolResultMessage.durationMs` and turns use `AssistantMessage.durationMs` (both absent on legacy messages). `packages/protocol` is typed against pi `1.1.0`, which has these fields and `tool_execution_end.durationMs`.
- Every field derives from the event alone, so a snapshot at any `seq` plus the following events still equals the full reduction.
- Elapsed times compare `receivedAt` with the device's clock, clamped at 0.

## Tests

Reducer tests for the timing fields, the `thinkingMs` cap and the reconnect invariant over every fixture; unit tests for the status vocabulary, the duration formats, turns (and their identity across commits), grouping (no step lost or repeated over every fixture) and the density migration; an end-to-end test from a fixture's events through the store to "Thought for Ns"; component tests for every row, the turn views per density, the live-status row, the footer, the header dropdown, Settings, the composer, the picker and the conversation outline (items, current prompt, jumps and following live). Coverage per task in [`../plan/09-ui-overhaul.md`](../plan/09-ui-overhaul.md).

## Limitations

- Thinking durations aren't persisted (pi records none): they're kept in the agent's live state on the server, so a block reads "Thought", without a duration, after the pi process or the server restarts, in sessions opened from history, and once 500 newer blocks have finished.
- The files chip opens the working tree's review, not a diff of that turn; its counts are the turn's.
- Messages from pi before 1.1.0 have no `durationMs`: their tool rows show no duration, and a turn's duration ends where its last assistant message started.
- Elapsed timers assume the device's clock agrees with the server's.
- Turns off screen keep a placeholder height until rendered (`content-visibility: auto`), so an outline jump far from turns never rendered can land slightly off its prompt.
