#!/bin/sh
# pi wrapper for the smoke test: `PI_CODE_PI_BIN=scripts/smoke-pi.sh` adds the throwaway
# `/smoke-dialog` extension (scripts/smoke-extension.ts) to every server-spawned pi.
exec "${SMOKE_REAL_PI:-pi}" "$@" --extension "$(dirname "$0")/smoke-extension.ts"
