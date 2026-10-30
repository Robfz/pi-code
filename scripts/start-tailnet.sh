#!/usr/bin/env bash
# Builds the web app, exposes the server on the tailnet with `tailscale serve`, and runs it.
# The serve entries are removed when the script exits (Ctrl-C, terminal closed, or the server
# exiting on its own).
set -euo pipefail

port="${PI_CODE_PORT:-4180}"
curator_port="${PI_CODE_CURATOR_PORT:-4181}"

if [[ -z "${PI_CODE_HOSTNAME:-}" ]]; then
  PI_CODE_HOSTNAME="$(tailscale status --json |
    node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).Self.DNSName.replace(/\.$/, "")')"
fi
if [[ -z "$PI_CODE_HOSTNAME" ]]; then
  echo "Could not read the tailnet hostname; set PI_CODE_HOSTNAME." >&2
  exit 1
fi
export PI_CODE_HOSTNAME

pnpm build

trap 'tailscale serve --https=443 off || true; tailscale serve --https=8443 off || true' EXIT
tailscale serve --bg --https=443 "http://127.0.0.1:$port"
tailscale serve --bg --https=8443 "http://127.0.0.1:$curator_port"

# Not via `pnpm start`: pnpm forwards Ctrl-C's SIGINT to a child that already got it from the
# terminal, and the server treats a second SIGINT as "exit now" with status 1.
cd packages/server && node --import tsx src/main.ts
