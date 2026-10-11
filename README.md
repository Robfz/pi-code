# pi-code

A personal, mobile-first web client (installable PWA) for the [pi](https://github.com/earendil-works/pi) coding agent.
A small Node server on your Mac runs `pi --mode rpc` for each conversation and serves the app to your phone over your tailnet, using the same pi installation, config, extensions and session files as the pi TUI.

## Requirements

- macOS host with [mise](https://mise.jdx.dev) (installs Node LTS and pnpm from `.mise.toml`)
- [pnpm](https://pnpm.io) (via mise)
- [pi](https://github.com/earendil-works/pi) installed and configured (`pi` on `PATH`, logged in to a model provider)
- [Tailscale](https://tailscale.com) on the Mac and the phone, with **HTTPS certificates enabled** for the tailnet (admin console → DNS → HTTPS Certificates). Web Push and service workers need HTTPS.

## Setup

```sh
mise install
pnpm install
pnpm build        # builds the web app into packages/web/dist
```

## Running

Start the server (from the repo root; the server finds `packages/web/dist` relative to its own source):

```sh
PI_CODE_HOSTNAME=<mac>.<tailnet>.ts.net pnpm --filter @pi-code/server start
```

Expose it on the tailnet (one-time; `--bg` keeps the config across reboots):

```sh
tailscale serve --bg --https=443  http://127.0.0.1:4180   # the app and API
tailscale serve --bg --https=8443 http://127.0.0.1:4181   # the web-search curator proxy
```

Then open `https://<mac>.<tailnet>.ts.net` on the phone. On the Mac or a laptop, open the same URL in a browser tab: from 1024px wide the app docks a sidebar of live and recent conversations (grouped by folder or repo, with search), and one tab follows all of them at once.

Stop the server with Ctrl-C (or SIGTERM): it stops accepting requests, closes every pi process (stdin end, then SIGTERM after 5 s, SIGKILL after 10 s) and exits.

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PI_CODE_HOSTNAME` | required | Tailnet hostname, e.g. `mac.tail1234.ts.net`. Used for the Host allowlist, origin checks and curator links. Defaults to `localhost` when `NODE_ENV` is `development` or `test`. |
| `PI_CODE_PORT` | `4180` | Main listener (`127.0.0.1` only) |
| `PI_CODE_CURATOR_PORT` | `4181` | Curator proxy listener (`127.0.0.1` only) |
| `PI_CODE_PI_BIN` | `pi` | pi executable |
| `PI_CODE_DATA_DIR` | `~/.config/pi-code` | VAPID keys (`vapid.json`) and push subscriptions (`push-subscriptions.json`) |
| `PI_AGENT_DIR` | `~/.pi/agent` | pi's agent dir: sessions, `trust.json`. Read-only, except that deleting a conversation or removing a worktree deletes session files |

## Installing the PWA on Android

1. Open `https://<mac>.<tailnet>.ts.net` in Chrome on the phone (Tailscale connected).
2. Chrome menu → **Add to Home screen** → **Install**.
3. Open pi-code from the home screen, go to **Settings** and tap **Enable notifications**; allow the permission prompt.

You get a notification when a run finishes, fails, or waits for your input (dialogs, project trust); tapping it opens that conversation. The app icon badge shows how many agents need attention.

## Installing the PWA on the desktop

1. Open `https://<mac>.<tailnet>.ts.net` in Chrome or Edge (Tailscale connected).
2. Click the install icon in the address bar (or browser menu → **Install pi-code**). The app gets its own window and Dock icon; right-click the Dock icon for **New conversation**.
3. Go to **Settings** and click **Enable notifications**; allow the permission prompt. If no prompt appears, check the address bar for a blocked-notifications icon.

The browser must be running to receive notifications. A notification is shown only when no pi-code window is focused; a focused window shows a toast instead.

On macOS, notifications come from the browser (its name and icon) unless you enable `chrome://flags/#enable-mac-pwas-notification-attribution` (`edge://flags/…` in Edge) and restart the browser. pi-code then shows up in System Settings → Notifications as its own app: allow it there or at its first prompt, and keep **Badge app icon** on for the Dock badge.

## Development

```sh
pnpm dev          # server (tsx watch, NODE_ENV=development, hostname localhost) + Vite dev server
pnpm test         # vitest, all packages (uses a fake pi replaying recorded fixtures; no tokens spent)
pnpm check        # biome + typecheck
```

End-to-end smoke test against the real pi (spends a few cents with claude-haiku-4-5):

```sh
NODE_ENV=development PI_CODE_PORT=4199 PI_CODE_CURATOR_PORT=4200 \
  PI_CODE_DATA_DIR=/tmp/pi-code-smoke-data PI_CODE_PI_BIN=$PWD/scripts/smoke-pi.sh \
  pnpm --filter @pi-code/server start > /tmp/pi-code-smoke.log 2>&1 &
cd packages/server && SMOKE_URL=http://localhost:4199 pnpm exec tsx ../../scripts/smoke.ts [scenario numbers…]
```

The smoke script creates scratch projects under `~/tmp` and removes them, with their pi sessions, at the end (`SMOKE_KEEP=1` keeps them). See the header of `scripts/smoke.ts` for details. Test fixtures and the fake pi are described in [`test/README.md`](test/README.md).

## Known limitations

- Stopping the server kills all agents: in-flight runs and pending dialogs are lost; committed entries survive in the session files.
- When the search curator or MCP OAuth is triggered, pi also tries to open a browser on the Mac (shared config; left unchanged so the TUI keeps auto-opening).
- MCP Apps and MCP URL elicitation don't work from the web (deferred).
- Opening a web-owned session in the TUI at the same time corrupts the branch structure (pi has no session locking).
- A conversation with no new session entry for 7 days is closed automatically, pending dialogs included; its session file stays and can be resumed.
- Worktrees are created and removed only in repos laid out as `<repo>/main` (or `master`) whose parent folder isn't inside a git repo; plain clones stay flat folder groups. A repo with no session and no open conversation appears nowhere: the picker and `/sessions` list only session-derived entries. See [`docs/design/06-worktrees.md`](docs/design/06-worktrees.md) for the rest.
- A new worktree whose conversation closes before any message drops out of every listing; the folder stays, reachable through the picker's path field.
- Removing a worktree doesn't stop a TUI pi running in it: its next write recreates its session file, listed under a missing worktree.
- Deleting a conversation moves its session file to the server's Trash (recoverable only on that Mac, Finder → Put Back), or unlinks it for good where `trash` is missing. There is no confirmation except the Stop-or-Delete choice on live conversations. A conversation opened from a file outside pi's sessions folder is only stopped; its file is kept. See [`docs/design/07-delete-sessions.md`](docs/design/07-delete-sessions.md).
- The status bar's subagent spend `(sa $x)` counts calls that throw (Stop/abort, server shutdown) and cursor-runner calls as $0: their spend never reaches the session file.

## Documentation

- [`maps/`](maps/) — decision maps and their rationale
- [`docs/design/`](docs/design/) — system design: [overview](docs/design/00-overview.md), [server](docs/design/01-server.md), [API contract](docs/design/02-api-contract.md), [web client](docs/design/03-web-client.md), [pi extension](docs/design/04-pi-extension.md), [desktop](docs/design/05-desktop.md), [worktrees](docs/design/06-worktrees.md), [deleting sessions](docs/design/07-delete-sessions.md)
- [`docs/plan/`](docs/plan/) — implementation plan
- [`docs/spikes/`](docs/spikes/) — protocol spike findings
