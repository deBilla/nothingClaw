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
#   - `.env` is NOT bind-mounted into the sandbox. We parse it in this parent
#     wrapper and forward each KEY=VAL via --setenv. The agent process gets
#     the secrets it needs in its environment without the FILE existing at all
#     inside the namespace — so `Read({file_path: '.env'})` from a hijacked
#     turn returns ENOENT regardless of any in-process gate.
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

# Parse .env in the parent and stage --setenv flags. .env is the file the
# agent must NOT be able to read; the values inside it are what the process
# legitimately needs. Splitting "secrets in env" from "secrets in a file"
# closes the credential exfil path with no functional regression.
#
# Format we accept (a strict subset of dotenv): KEY=VALUE per line, blank lines
# and `#`-comments allowed, optional surrounding single or double quotes on the
# value. Anything fancier (variable expansion, multiline) is rejected loudly.
SETENV_FLAGS=()
if [[ -r "$ROOT/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"   # ltrim
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" != *"="* ]]; then
      echo "run-linux.sh: ignoring malformed .env line (no '='): $line" >&2
      continue
    fi
    key="${line%%=*}"
    val="${line#*=}"
    # Strip matched surrounding quotes.
    if [[ "${val:0:1}" == "\"" && "${val: -1}" == "\"" ]] || \
       [[ "${val:0:1}" == "'"  && "${val: -1}" == "'"  ]]; then
      val="${val:1:${#val}-2}"
    fi
    [[ -z "$key" ]] && continue
    SETENV_FLAGS+=(--setenv "$key" "$val")
  done < "$ROOT/.env"
fi

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
  --ro-bind "$BUN_BIN" /usr/local/bin/bun \
  $([[ -n "$NODE_BIN_DIR" ]] && echo --ro-bind "$NODE_BIN_DIR" /usr/local/lib/node) \
  --setenv PATH "/usr/local/bin:/usr/local/lib/node:/usr/bin:/bin" \
  --setenv HOME "$HOME" \
  --setenv NODE_PATH "$ROOT/node_modules" \
  --setenv HTTPS_PROXY "http://127.0.0.1:${EGRESS_GATEWAY_PORT:-8775}" \
  --setenv HTTP_PROXY "http://127.0.0.1:${EGRESS_GATEWAY_PORT:-8775}" \
  --setenv ALL_PROXY "http://127.0.0.1:${EGRESS_GATEWAY_PORT:-8775}" \
  --setenv NO_PROXY "127.0.0.1,localhost" \
  "${SETENV_FLAGS[@]}" \
  --chdir "$ROOT" \
  --unshare-all --share-net \
  --new-session --die-with-parent \
  --cap-drop ALL \
  /usr/local/bin/bun run "$ROOT/src/cli/index.ts" start

# AIRTIGHT EGRESS (Linux netns) — NOT enabled above, and NOT yet validated.
#
# The proxy env vars above are a best-effort hint (Node's fetch/undici ignores
# them). True enforcement = run the bot in a network namespace whose ONLY route
# is the gateway, so no library can bypass it. The standard rootless approach is
# slirp4netns bound to a single allowed upstream, or a veth pair + nftables that
# DNATs the gateway and drops everything else.
#
# Because this needs validation on a real Linux host (it can't be exercised on
# the macOS dev machine), it is intentionally left as a documented next step
# rather than shipped untested. When you implement it, set
# MARSCLAW_EGRESS_ENFORCED=1 (via --setenv) ONLY in the branch where the netns
# was successfully established — that flag is what relaxes the URL allow-list.
