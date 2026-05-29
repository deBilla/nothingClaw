# Kernel sandbox stubs

The in-process gates in [src/lib/tool-permissions.ts](../../src/lib/tool-permissions.ts) and friends are best-effort: a bug in the gate, a deserialization issue inside the SDK, or a compromised dependency can step around them. The files in this directory move the most important defenses *into the kernel*, where a buggy or hijacked agent process **cannot** read `.env`, `~/.claude.json`, or `data/secrets/` regardless of what the gate says.

This is a stub. Read the source comments before deploying — there are deliberate gaps (no seccomp profile yet, MCP credential split not done, network egress still open).

## Files

| File | Platform | What it does |
|---|---|---|
| `marsclaw.sb` | macOS | sandbox-exec profile — **deny-default**; broad allows for Bun/Node + credential denies. Expect to add allows on first runs (see profile header). |
| `run-macos.sh` | macOS | Wrapper that starts the bot under the profile + sets egress proxy env. |
| `run-linux.sh` | Linux | bubblewrap wrapper — FS namespacing, dropped caps, tmpfs HOME, `.env` passed via `--setenv` (not bind-mounted), egress proxy env. |
| `launch-hardened.sh` | both | Supervisor: starts the egress gateway + LLM proxy (opt-in via env) then execs the sandboxed bot. The single entry point for the hardened service. |
| `pf-anchor.conf` | macOS | Packet-filter rules — the REAL egress enforcer (drops outbound from the bot's user except to the gateway + DNS). |
| `install-pf-anchor.sh` | macOS | sudo loader for the pf anchor. |
| `seccomp.json` | Linux | OCI-format syscall denylist (ptrace/mount/setns/bpf/…). For Docker `--security-opt` or libseccomp compilation. |

## Hardened service install

`bun run service install --hardened` installs a launchd plist that runs
`launch-hardened.sh` instead of the bot directly. Toggle layers via the plist's
`EnvironmentVariables`:

- `EGRESS_GATEWAY=1` — start the SSRF-protected egress gateway
- `LLM_PROXY=1` (+ `MARSCLAW_LLM_PROXY_URL`/`MARSCLAW_LLM_PROXY_TOKEN`) — credential isolation
- `SANDBOX=1` (default) — run the bot under the platform sandbox wrapper
- `MARSCLAW_EGRESS_MODE=gateway` + `MARSCLAW_EGRESS_ENFORCED=1` — relax the URL allow-list (only after the pf anchor is loaded on macOS)

The default `bun run service install` (no flag) is unchanged — bot runs directly.

## How to use

### macOS

```bash
chmod +x tools/sandbox/run-macos.sh
./tools/sandbox/run-macos.sh
```

To make this the default for the launchd service, edit [`launchd/com.marsclaw.plist`](../../launchd/com.marsclaw.plist):

```xml
<key>ProgramArguments</key>
<array>
    <string>{{PROJECT_ROOT}}/tools/sandbox/run-macos.sh</string>
</array>
```

…and rerun `bun run service install`. Verify with `sudo lsof -p <pid>` that the agent process cannot stat `~/.claude.json`.

### Linux

```bash
sudo apt install bubblewrap     # or: dnf install bubblewrap
chmod +x tools/sandbox/run-linux.sh
./tools/sandbox/run-linux.sh
```

systemd unit equivalent — drop the wrapper into `ExecStart=`.

## What the sandbox closes

| Attack | Without sandbox | With sandbox |
|---|---|---|
| Injected agent runs `cat ~/.claude.json` (via `Bash` or via a misbehaving dep) | Reads OAuth token, full exfiltration | macOS: denied by profile. Linux: file does not exist in the namespace (tmpfs HOME). |
| Injected agent reads `.env` via `Read` tool when [sensitive-paths.ts](../../src/lib/sensitive-paths.ts) has a bug | Reads channel tokens, Google client secret | macOS: denied. Linux: only `.env` is bind-mounted read-only — content still readable today, see "Known gaps" below. |
| Injected agent reads SSH keys | Trivially possible if `allow_shell=true` | Denied. |

## What it does NOT close (yet)

- **Seccomp / syscall filter.** A separate libseccomp BPF blob compiled and handed to `bwrap --seccomp` would block `ptrace`/`mount`/`setns`/`kexec`. Add `tools/sandbox/seccomp.bpf` in a follow-up.
- **Network egress.** Both wrappers leave network open so the bot can reach Telegram/Slack/Anthropic. Pair with `tools/llm-proxy/` and tighten the sandbox to allow only loopback to get the "no third-party egress" property by kernel rule, not by policy.
- **MCP credential split.** The MCP child currently inherits the parent's sandbox, so `data/secrets/` (Google OAuth refresh tokens on Linux) is bind-mounted into the agent's view. Proper fix: run the MCP server as a separate launchd/systemd unit *outside* the sandbox; expose it to the agent via a bind-mounted Unix socket so the agent process sees the socket but never the on-disk credentials.
- **`.env` still readable in the Linux sandbox.** The bot needs it at startup to read channel tokens. To close: have `setup.sh` populate channel tokens into `data/secrets/` and `.env` into a parent-only path, then unset both inside the sandbox after they're consumed.
- **Supply-chain risk.** A malicious npm package still runs *inside* the sandbox — it can do anything the policy permits. This is unfixable in-process. See [docs/vs-nanoclaw.md](../../docs/vs-nanoclaw.md).

## Verification

After starting the bot under the sandbox, from another shell:

```bash
# Send a message that asks the bot to read .claude.json. The reply should
# describe a failure to read the file, and logs/audit.log should show the
# denial. Without the sandbox, the file read might succeed (depending on
# allowed_paths) and only the in-process gate would catch it.

# Check what the agent can see (Linux):
sudo nsenter -t $(pgrep -f 'bun run.*start' | head -1) -m ls -la $HOME
# expect: empty tmpfs, no .claude.json, no .ssh, no .gemini
```
