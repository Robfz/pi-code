# pi-code — Web client for pi: decision map

## Context & constraints
- [settled] Build from scratch — no reuse of existing pi web clients (user's prior research)
- [settled] Security posture: pi runs tools with the host user's full permissions, no per-tool approval; risk accepted by user
- [settled] Reachability: tailnet only — private network, no public exposure
- [settled] Users: single user (owner only) — no multi-tenancy, one set of credentials; nobody else on the tailnet
- [settled] Host machine: server + pi run on the user's Mac — user's call, "for now"
- [settled] Client devices: phone/tablet first; other laptops or the Mac itself later if the project succeeds — user's call
- [settled] Mobile-first layout — follows from phone/tablet being the primary clients

## Integration with pi
- [settled] Integrate via `pi --mode rpc` subprocess — documented, stable protocol preferred over internal SDK API
- [settled] Web UI and TUI share the same pi backend — same install, config, extensions; only the rendering layer differs
- [settled] TUI↔web interop: sequential handoff — one side owns a session at a time; same session files; server releases its pi process before the TUI resumes (and vice versa)
- [settled] Simultaneous attach is out — pi has no session-file locking or watching; two processes would write divergent branches into one file
- [settled] Session file state can't reveal an active owner: pi locks settings/auth/trust but never session files, keeps no PID registry, and doesn't hold the file open (append-and-close, so lsof misses it); an idle TUI session is indistinguishable from a closed one
- [settled] Single ownership enforced on the web side only — server guards its own sessions; not opening them in the TUI meanwhile is on the user
- [settled] Server provides a session list across all projects — user's call
- [settled] pi settings (settings.json, models.json) are not edited in the web UI — TUI/files concern (user); per-session model/thinking switching stays, via RPC, as part of parity
- [settled] Package install/remove is not in the web UI — TUI concern (user)
- [settled] Provider login (API keys / OAuth for model providers) is TUI-only for now — user's call

## Access & auth
- [settled] Project trust can't be prompted over RPC: projects already trusted in the TUI (~/.pi/agent/trust.json) load their .pi resources; a never-trusted project opened from the web silently skips them (defaultProjectTrust "ask")
- [settled] Project trust: the web UI asks the first time (option c) — user's call; the server asks before spawning pi (extensions can't show UI during `project_trust` in RPC mode) and passes the answer via `PI_CODE_TRUST`; a pi-code extension returns it with `remember: true`, so pi saves it to trust.json, shared with the TUI
- [settled] Server binds to 127.0.0.1, exposed only via `tailscale serve` (tailnet-only HTTPS); no app login — simplest secure option, agent recommendation on user's delegation

## Runtime model
- [settled] Focus on a single conversation first — user wants depth on one conversation before breadth
- [deferred] Multiple concurrent sessions on different folders — possibly useful, unconfirmed; user's call to revisit later
- [settled] One device attached to a conversation at a time — multi-device simultaneous use isn't a use case
- [settled] Runs continue server-side with no browser connected — close the phone, come back later
- [settled] pi process lifecycle: a session's pi process lives until the user explicitly closes it in the web UI — user's call; closing is also what hands the session back to the TUI
- [settled] Server started by hand for now — user's call
- [settled] pi processes are children of the server: stopping or restarting it (e.g. closing its terminal) kills in-flight runs and pending dialogs; finished messages survive in the session files
- [deferred] launchd service (start at login) — later, user's call
- [settled] Server retains in-flight state (streaming message, running tools, pending dialogs) for reconnect — pi's event stream isn't replayable
- [settled] Workspace model: any directory under the user's home can be opened as a project — user's call
- [settled] Project folder picker: recent projects (from session headers' `cwd`) + path autocomplete under ~ — user's call

## Features
- [settled] Target feature parity with the TUI — user's goal
- [settled] All installed extensions must work in the web UI — where RPC degrades them, rebuild the widget client-side or rebuild the extension
- [deferred] herdr-agent-state extension — out of scope, user's call
- [settled] exit-command, label — work as-is over RPC (need `notify` + slash commands)
- [settled] subagent — same backend tool for TUI and web; web builds its own progress widget from tool `details`
- [settled] Status bar — native web component similar to the TUI status-bar (folder/branch/dirty, context bar, session name, model+effort, cost)
- [settled] pi-web-access / pi-mcp-adapter under RPC (acknowledged): tools, dialogs, OAuth paste-back work; MCP setup panels degrade to a notify; search curator, MCP Apps widgets and OAuth auto-open start a localhost HTTP server + open a browser on the pi host; MCP URL elicitation disabled outside TUI; several custom message types to render
- [settled] Host-browser flows on mobile: web client surfaces them (option b), user expects a copy-paste flow
- [settled] Copy-paste only covers OAuth (external auth URL, then paste back the failed localhost redirect URL); curator and MCP Apps are pages on 127.0.0.1:<random port> of the Mac — the phone can't open them unless the server proxies them
- [settled] Curator must fully work from the phone — Mac-only is unacceptable (user)
- [deferred] MCP URL elicitation on mobile — needs a pi-mcp-adapter patch; user's call to defer
- [deferred] MCP Apps on mobile — user doesn't use MCP servers that ship apps; revisit if one does (user's call)
- [settled] Curator (optional search-result review page, unused today) is proxyable via config only: `curatorRemote` + `autoOpenBrowser:false` in web-search.json; URL arrives structured in tool `details.curatorUrl`; page is single-origin with relative URLs
- [settled] MCP Apps aren't proxyable without patching pi-mcp-adapter: two loopback-only servers; `http://localhost:<port>` origins are baked into the served pages and checked strictly via postMessage; Host header must be localhost
- [settled] URL elicitation is disabled over RPC by one line (`allowUrl: mode === "tui"`, no config flag); once enabled, URL is shown in a select dialog title; `/mcp-auth` OAuth paste-back works over RPC; both also try to open a browser on the Mac
- [deferred] Strategy for patching pi-mcp-adapter — only needed for MCP Apps / URL elicitation, both deferred
- [settled] Actual exposure today (acknowledged): curator not configured (default workflow "none", opens only on request); MCP servers are linear (76 tools, no MCP Apps UI) and figma (imported from Claude Code); OAuth only on first connect/token expiry
- [settled] RPC has no in-place tree navigation (TUI `/tree`); extension commands can call `ctx.navigateTree`, so the pi-code extension exposes it as a command the web invokes via `prompt`
- [settled] Tools with TUI renderers (renderCall/renderResult) that parity implies web renderers for: built-ins (read, bash, edit, write, grep, find, ls), subagent, pi-web-access (web_search, fetch_content, …), pi-mcp-adapter (`mcp` proxy + namespace tools); anything else needs a generic fallback (args + text result)
- [settled] Tool renderers: all TUI-rendered tools get web renderers in the first milestone (built-ins, subagent, pi-web-access, pi-mcp-adapter) + generic fallback — user's call
- [settled] Delivery phasing: the first milestone contains every settled feature — user's call; agent noted the risk of validating the core (SSE + in-flight buffer + reconnect) late
- [settled] Diffs are first-class — user's priority
- [settled] Diff data (acknowledged): `edit` returns a unified patch in `details.patch`; `write` returns no diff; changes made via bash return nothing — full coverage needs a git diff computed by the server
- [settled] Diff scope: both — per-edit patches inline in the conversation; git working-tree diff as an explicit UI action and/or command (user)
- [settled] A small extension can give `write` a diff: snapshot the file on `tool_call`, then attach a patch via `tool_result` (handlers may replace `details`); it would load in the TUI too
- [deferred] Inline before/after for `write` overwrites (observer extension) — dropped for now, user's call; new files show as all-added, git diff action covers overwrites
- [settled] Approval is possible: an extension's `tool_call` handler can block a call, and `ctx.ui.confirm` works over RPC — e.g. approve edits/writes/bash from the phone; applies to the TUI too (shared backend)
- [deferred] Tool-call approval — "not yet", user's call
- [settled] No file explorer — user's call
- [settled] `!cmd` / `!!cmd` bash prefixes as in the TUI — user's call
- [settled] `!`/`!!` map directly onto the RPC `bash` command (`excludeFromContext`) with streamed output; a real terminal would use xterm.js + node-pty (mature libraries, not from scratch)
- [settled] Terminal options (acknowledged): xterm.js is solid on desktop but weak on mobile (no Ctrl/Esc/Tab/arrows on soft keyboards → needs a key bar; clunky touch selection; IME glitches); node-pty is a native module; ttyd is an off-the-shelf xterm.js server that could be proxied with zero building; `!`/`!!` can't run interactive programs
- [deferred] Terminal — user's call; `!`/`!!` cover one-shot commands meanwhile
- [settled] Image upload from phone camera/photos — RPC `prompt` accepts base64 images natively (user)
- [settled] Mobile push notifications required; app installed to the Android home screen as a PWA — user's call
- [settled] Desktop notifications are nice-to-have, not required — user's call
- [settled] PWA features on Android (acknowledged): installable app (manifest + service worker), Web Push, app icon badge, share target (share text/links from other apps into a prompt); offline mode has little value since everything lives on the Mac
- [settled] PWA features: install, Web Push, app icon badge, share target — user's call
- [settled] Notification triggers: run finished, extension dialog awaiting an answer, run failed — user's call

## Tech
- [settled] pi ships TypeScript protocol types (`dist/modes/rpc/rpc-types.d.ts`) and an `RpcClient`; a TypeScript server gets a typed protocol for free, other languages must hand-write it
- [settled] Server and frontend both in TypeScript — user's call
- [settled] Browser↔server transport options: WebSocket (one bidirectional channel) vs SSE + HTTP POST (built-in reconnect with `Last-Event-ID`); either way a few plain HTTP endpoints remain (session list, path autocomplete, push subscription, curator proxy); server↔pi stays JSONL over stdio
- [settled] Server framework options (acknowledged): none (node:http, hand-rolled routing/SSE), Hono (small, web-standard; `streamSSE`, `hono/proxy` helpers; Node or Bun), Fastify (mature, plugin ecosystem incl. `@fastify/http-proxy`), Express (ubiquitous, dated); the server only spawns pi, so its runtime can be Node or Bun
- [settled] Browser↔server transport: SSE (server→browser, resume via `Last-Event-ID`) + HTTP POST for actions — user's preference, agent concurs: traffic is asymmetric, plain HTTP is easier to debug, resume maps onto the in-flight buffer
- [settled] `tailscale serve` streams SSE unbuffered — it proxies via Go's httputil.ReverseProxy (ipn/ipnlocal/serve.go), which flushes `text/event-stream` responses immediately
- [settled] Server: Hono on Node (latest stable), version managed with mise — user's call
- [settled] Frontend options (acknowledged): plain Vite SPA served by the server (SSR meta-frameworks add a server we already have); React (largest ecosystem: diff viewers, markdown, virtualization; streaming needs render care), Svelte 5 (less code, fast, smaller ecosystem), SolidJS (fine-grained reactivity suits token streaming, smallest ecosystem), Vue 3 (middle ground); PWA via framework-agnostic vite-plugin-pwa
- [settled] Frontend: React, as a Vite SPA served by the server — user's call
- [settled] Remaining frontend decisions (acknowledged): state management (streaming transcript store + server data), styling / component library, routing, rendering libraries (markdown, syntax highlighting, diff viewer, long-list virtualization)
- [settled] Decide all frontend topics now — user asked for options on each
- [settled] State options — server data: TanStack Query, SWR, plain fetch; live conversation store: Zustand (selector subscriptions limit re-renders), Jotai (atoms), Redux Toolkit (verbose, strong devtools), useReducer + context (re-renders everything on each token)
- [settled] Styling options: Tailwind v4 + shadcn/ui (components copied into the repo, Radix primitives), Mantine (batteries-included), MUI (Material look, heavy), CSS Modules (no framework)
- [settled] State: TanStack Query for server data (user); Zustand for the live conversation — agent recommendation on user's delegation: Redux-like single store/actions/selectors (fits user's Redux experience, works with Redux DevTools) without the boilerplate; per-slice subscriptions keep token streaming cheap
- [settled] Styling: Tailwind v4 + shadcn/ui — user's call
- [settled] URL routing is needed: notification taps, the share target and the PWA back button all land on URLs
- [settled] Routing options: TanStack Router (type-safe routes/search params, pairs with TanStack Query), React Router v7 (mature, familiar), wouter (tiny)
- [settled] Routing: TanStack Router — agent's pick on user's delegation: type-checked routes/params, same family as TanStack Query
- [settled] Rendering options — markdown: react-markdown + remark-gfm (re-parses each delta, mangles unterminated blocks), Streamdown (Vercel's drop-in replacement built for streaming, bundles Shiki highlighting); diffs: @git-diff-view/react (GitHub-style, split/unified, highlighting, web worker), react-diff-view (renders unified patches), diff2html (framework-agnostic HTML); virtualization: TanStack Virtual (headless, documented chat/end-anchoring mode), react-virtuoso (chat-ready, known follow-output glitches under fast updates), none initially
- [settled] Markdown + code highlighting: Streamdown (bundles Shiki) — agent's pick on user's delegation: built for streaming, tolerates unterminated markdown
- [settled] Diff viewer: @git-diff-view/react — agent's pick on user's delegation: takes unified hunks, so one component serves both `edit` patches and the git-diff action; unified mode on phones
- [deferred] List virtualization — agent's pick on user's delegation: render plainly first, add TanStack Virtual (chat/end-anchoring mode) only if long sessions measurably lag
