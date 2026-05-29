#!/usr/bin/env bash
# Load the marsClaw pf egress anchor (macOS). Needs sudo. STUB — validate on
# your machine before relying on it; pf-by-user behavior depends on the bot
# running as its own dedicated user (see pf-anchor.conf header).
#
# After this succeeds AND you've confirmed the rules with
#   sudo pfctl -a com.marsclaw -s rules
# set MARSCLAW_EGRESS_ENFORCED=1 in the bot's launchd plist / .env to relax the
# URL allow-list (the egress gateway then becomes the boundary).

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install-pf-anchor.sh: macOS only" >&2
  exit 1
fi
if [[ "$(id -u)" != "0" ]]; then
  echo "install-pf-anchor.sh: re-run with sudo" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ANCHOR="$ROOT/tools/sandbox/pf-anchor.conf"
ANCHOR_NAME="com.marsclaw"

# Ensure pf is enabled (no-op if already on).
pfctl -E 2>/dev/null || true

# Load the anchor rules.
pfctl -a "$ANCHOR_NAME" -f "$ANCHOR"

echo "Loaded pf anchor '$ANCHOR_NAME'. Current rules:"
pfctl -a "$ANCHOR_NAME" -s rules

cat <<EOF

Next:
  1. Confirm the bot runs as the user named in pf-anchor.conf (default _marsclaw).
  2. To make this survive reboot, add to /etc/pf.conf:
       anchor "$ANCHOR_NAME"
       load anchor "$ANCHOR_NAME" from "$ANCHOR"
     then: sudo pfctl -f /etc/pf.conf
  3. Set MARSCLAW_EGRESS_ENFORCED=1 in the bot's environment to relax the
     URL allow-list now that egress is enforced at the packet layer.
EOF
