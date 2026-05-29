#!/usr/bin/env bash
# Run marsClaw under bubblewrap on Linux. STUB — enough to demonstrate the
# kernel-enforced FS containment property, not a finished hardening pass.
#
# What this does:
#   - Read-only system dirs (/usr, /etc, /lib*, /bin, /sbin)
#   - Read-write only on $ROOT/data and $ROOT/logs (the bot's writable surface)
#   - Read-only on the source tree, node_modules, package.json, tsconfig.json
#   - HOME is bind-mounted as a tmpfs so the agent cannot read ~/.claude.json,
#     ~/.gemini/, ~/.ssh, etc. — they simply do not exist inside the sandbox.
#   - --unshare-all (mount/ipc/pid/uts/cgroup/user namespaces), --share-net
#     keeps network reachability while isolating everything else.
#   - --new-session + --die-with-parent + --cap-drop ALL
#
# What this does NOT do yet:
#   - seccomp filter. bwrap's --seccomp <fd> accepts a libseccomp BPF blob;
#     producing one is out of scope for this stub. A reasonable starting
#     profile is "deny ptrace, mount, setns, kexec, bpf, perf_event_open,
#     keyctl, add_key, request_key" — see misc/seccomp.bpf (future).
#   - Network namespace isolation. We --share-net so the bot can reach
#     Telegram/Slack/Anthropic; pair with the llm-proxy sidecar to get the
#     "agent only sees loopback" property.
#   - MCP credential split. Today the MCP child inherits the parent's sandbox,
#     so data/secrets/ (Linux Google OAuth refresh tokens fallback) is bind-
#     mounted into the sandbox so the broker can read them. That re-exposes
#     those files to the agent process. Properly: start the MCP server OUTSIDE
#     the sandbox and have the agent connect via a Unix socket bind-mounted in.

set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "run-linux.sh: not on Linux — use run-macos.sh" >&2
  exit 1
fi
if ! command -v bwrap >/dev/null 2>&1; then
  echo "run-linux.sh: bubblewrap (bwrap) not installed. Try: apt install bubblewrap" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Locate bun via the user shell once, BEFORE entering the sandbox — PATH inside
# the sandbox will be minimal.
BUN_BIN="${BUN_BIN:-$(command -v bun || true)}"
if [[ -z "$BUN_BIN" ]]; then
  echo "run-linux.sh: 'bun' not on PATH. Set BUN_BIN=/path/to/bun" >&2
  exit 1
fi

# Optional: pass through nvm's node dir so the SDK subprocess can find node.
NODE_BIN_DIR="$(dirname "$(command -v node || true)")"

exec bwrap \
  --ro-bind /usr /usr \
  --ro-bind /etc /etc \
  --ro-bind /lib /lib \
  $([[ -d /lib64 ]] && echo --ro-bind /lib64 /lib64) \
  --ro-bind /bin /bin \
  --ro-bind /sbin /sbin \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --tmpfs "$HOME" \
  --ro-bind "$ROOT/src" "$ROOT/src" \
  --ro-bind "$ROOT/node_modules" "$ROOT/node_modules" \
  --ro-bind "$ROOT/package.json" "$ROOT/package.json" \
  --ro-bind "$ROOT/tsconfig.json" "$ROOT/tsconfig.json" \
  --ro-bind "$ROOT/skills" "$ROOT/skills" \
  --ro-bind "$ROOT/MEMORY.md" "$ROOT/MEMORY.md" \
  --ro-bind "$ROOT/CLAUDE.md" "$ROOT/CLAUDE.md" \
  --bind "$ROOT/data" "$ROOT/data" \
  --bind "$ROOT/logs" "$ROOT/logs" \
  --ro-bind "$ROOT/.env" "$ROOT/.env" \
  --ro-bind "$BUN_BIN" /usr/local/bin/bun \
  $([[ -n "$NODE_BIN_DIR" ]] && echo --ro-bind "$NODE_BIN_DIR" /usr/local/lib/node) \
  --setenv PATH "/usr/local/bin:/usr/local/lib/node:/usr/bin:/bin" \
  --setenv HOME "$HOME" \
  --setenv NODE_PATH "$ROOT/node_modules" \
  --chdir "$ROOT" \
  --unshare-all --share-net \
  --new-session --die-with-parent \
  --cap-drop ALL \
  /usr/local/bin/bun run "$ROOT/src/cli/index.ts" start
