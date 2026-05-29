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

# sandbox-exec emits a noisy deprecation warning on every invocation —
# acknowledged, still works, no alternative for this use case yet.
exec sandbox-exec \
  -f "$PROFILE" \
  -D "PROJECT=$ROOT" \
  -D "HOME=$HOME" \
  bun run "$ROOT/src/cli/index.ts" start
