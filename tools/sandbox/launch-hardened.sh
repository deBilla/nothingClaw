#!/usr/bin/env bash
# Hardened launcher — the single entry point a launchd/systemd unit can call to
# bring up the full NemoClaw-style stack:
#   1. egress gateway (SSRF-protected proxy)   — if EGRESS_GATEWAY=1
#   2. LLM credential proxy                     — if LLM_PROXY=1
#   3. the bot, under the kernel sandbox wrapper
#
# Companions run as background children; this script waits on the bot and tears
# the children down when it exits (or on SIGTERM/SIGINT). It is intentionally
# simple — one level of supervision, no restart-on-crash for the companions
# (launchd/systemd restarts the whole unit if this script exits non-zero).
#
# Opt-in via env. With nothing set it just runs the sandboxed bot, so it's safe
# to point a service at unconditionally.
#
# COMPATIBILITY: must run under macOS's stock /bin/bash 3.2 — so NO negative
# array subscripts (${arr[-1]}) and no bare ${arr[@]} under `set -u`. We track
# child PIDs in explicit scalars instead of an array.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

GATEWAY_PORT="${EGRESS_GATEWAY_PORT:-8775}"
LLM_PORT="${LLM_PROXY_PORT:-8765}"
GW_PID=""
PROXY_PID=""
BOT_PID=""

cleanup() {
  [ -n "$GW_PID" ] && kill "$GW_PID" 2>/dev/null || true
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true
  [ -n "$BOT_PID" ] && kill "$BOT_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait_for_port() {
  port="$1"; name="$2"; tries=0
  until nc -z 127.0.0.1 "$port" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -gt 50 ]; then
      echo "launch-hardened: $name did not come up on :$port after 5s" >&2
      return 1
    fi
    sleep 0.1
  done
}

if [ "${EGRESS_GATEWAY:-}" = "1" ]; then
  echo "launch-hardened: starting egress gateway on :$GATEWAY_PORT"
  bun run "$ROOT/tools/egress-gateway/gateway.ts" &
  GW_PID=$!
  wait_for_port "$GATEWAY_PORT" "egress-gateway" || exit 1
fi

if [ "${LLM_PROXY:-}" = "1" ]; then
  echo "launch-hardened: starting LLM proxy on :$LLM_PORT"
  bun run "$ROOT/tools/llm-proxy/proxy.ts" &
  PROXY_PID=$!
  wait_for_port "$LLM_PORT" "llm-proxy" || exit 1
fi

# Pick the platform sandbox wrapper. If neither applies (or SANDBOX=0), run the
# bot directly.
WRAPPER=""
case "$(uname -s)" in
  Darwin) WRAPPER="$ROOT/tools/sandbox/run-macos.sh" ;;
  Linux)  WRAPPER="$ROOT/tools/sandbox/run-linux.sh" ;;
esac

if [ "${SANDBOX:-1}" = "1" ] && [ -x "$WRAPPER" ]; then
  echo "launch-hardened: starting bot under sandbox ($WRAPPER)"
  "$WRAPPER" &
  BOT_PID=$!
else
  echo "launch-hardened: starting bot without sandbox wrapper"
  bun run "$ROOT/src/cli/index.ts" start &
  BOT_PID=$!
fi

# Wait on the bot. When it exits, the trap tears down companions.
wait "$BOT_PID"
