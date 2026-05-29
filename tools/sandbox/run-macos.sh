#!/usr/bin/env bash
# Run marsClaw under macOS sandbox-exec. See tools/sandbox/marsclaw.sb for the
# policy and tools/sandbox/README.md for what it does and doesn't protect.
#
# Intended use:
#   1) Replace `bun run start` in com.marsclaw.plist with this script, OR
#   2) Run interactively for testing:  ./tools/sandbox/run-macos.sh
#
# Env passthrough is identical to bare `bun run start` — sandbox-exec does not
# scrub env vars. The sandbox only narrows filesystem (and optionally network
# and process-exec) access.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILE="$ROOT/tools/sandbox/marsclaw.sb"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "run-macos.sh: not on macOS — use run-linux.sh" >&2
  exit 1
fi

if [[ ! -r "$PROFILE" ]]; then
  echo "run-macos.sh: missing profile at $PROFILE" >&2
  exit 1
fi

# Egress routing (best-effort on macOS). Pointing proxy env vars at the local
# gateway routes any component that honors them. This is a HINT, not
# enforcement — Node's global fetch/undici and several client libraries ignore
# proxy env. The REAL enforcer on macOS is the pf anchor (see
# tools/sandbox/pf-anchor.conf + install-pf-anchor.sh), which drops outbound at
# the socket layer regardless of library behavior.
GATEWAY_PORT="${EGRESS_GATEWAY_PORT:-8775}"
export HTTPS_PROXY="http://127.0.0.1:${GATEWAY_PORT}"
export HTTP_PROXY="http://127.0.0.1:${GATEWAY_PORT}"
export ALL_PROXY="http://127.0.0.1:${GATEWAY_PORT}"
export NO_PROXY="127.0.0.1,localhost"

# MARSCLAW_EGRESS_ENFORCED gates the URL-allowlist relaxation. We do NOT set it
# automatically: verifying the pf anchor is loaded needs root, and the bot
# launch isn't root. Set it to 1 in your launchd plist / .env ONLY after
# installing and verifying the pf anchor (install-pf-anchor.sh). Until then the
# allow-list stays the boundary — the safe default the operator chose.
if [[ "${MARSCLAW_EGRESS_ENFORCED:-}" == "1" ]]; then
  echo "run-macos.sh: egress enforcement asserted — URL allow-list will be relaxed" >&2
else
  echo "run-macos.sh: egress NOT asserted enforced — URL allow-list remains active (install pf anchor + set MARSCLAW_EGRESS_ENFORCED=1 to relax)" >&2
fi

# sandbox-exec emits a noisy deprecation warning on every invocation —
# acknowledged, still works, no alternative for this use case yet.
exec sandbox-exec \
  -f "$PROFILE" \
  -D "PROJECT=$ROOT" \
  -D "HOME=$HOME" \
  bun run "$ROOT/src/cli/index.ts" start
