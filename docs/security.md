# Security

This is the canonical security doc for marsClaw. It states the **threat model**, the **architecture that enforces it**, every **config flag with its security meaning**, and an honest list of **residual risks the design does not cover** so you can decide whether they matter for your use.

Short read: marsClaw is a single-process, single-user personal bot. The defensive principle is **"can't prevent injection, so shrink blast radius and log everything"** — the agent is structurally egress-less by default, can only act through a narrow validated surface, and every attempt lands in an append-only audit log.

There are now **two layers** to that principle, and they compose:
1. **Input restriction** (the original layer): capability flags, the URL allow-list, sensitive-path denials. Cheap, cross-platform, on by default. Costs some capability (the agent can't read off-allow-list pages).
2. **Blast-radius containment** (the NemoClaw-style layer, opt-in): an SSRF-protected egress gateway, LLM-credential isolation, a kernel sandbox, and per-call mutation approval. These shrink what a *hijacked* agent can *do* rather than what it can *read* — so turning them on lets you *relax* the input restrictions (open the URL allow-list, enable WebSearch fully) without losing security. See [vs-nanoclaw.md](vs-nanoclaw.md) for where this lands relative to the containerized cousin.

The containment layer is **off by default** and platform-dependent — read "The honest platform constraint" below before relying on it.

## The threat we defend against

A **prompt-injected agent**. The bot routinely reads attacker-influenceable text — email bodies via Gmail tools, web pages via WebFetch, search snippets, even chat messages from anyone allowed to message the bot. Any of that content can carry "ignore previous instructions, do X" payloads. We design as though every turn could be hostile.

## Threats we explicitly do **not** claim to defend against

In rough order of risk:

1. **Supply-chain compromise.** The Claude Agent SDK, `googleapis`, every dep in `node_modules` runs in-process as you. A malicious package bypasses every gate. Only kernel/container isolation closes this — see [vs-nanoclaw.md](vs-nanoclaw.md).
2. **The model provider.** Your context goes to Anthropic / Google on every turn. Inherent to using a hosted model.
3. **Host-level compromise.** The bot runs as your user; if your account is compromised, all bets are off.
4. **The model itself misbehaving without injection.** Hallucinated outputs in chat aren't a security event — they're a quality event.

If any of these are your real threat, marsClaw is the wrong tool. Use NanoClaw / a containerised agent.

## Architecture: agent thinks, broker acts

```
    untrusted in →  [ AGENT / "executive" ]      ← no secrets, no shell, no
                            │                       direct egress by default
                            │ requests actions (typed)
                            ▼
                     [ BROKER (MCP server) ]      ← holds Google creds; sole
                      • allowlist (URLs, ...)        path to the outside
                      • mutation gate
                      • append-only audit log
                            │
                            ▼
              Google APIs · web (via researcher) · the user
```

- The MCP server is a separate process from the agent.
- The MCP child env passthrough in [src/providers/claude-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/claude-sdk.ts) explicitly **withholds `ANTHROPIC_API_KEY`** from the broker — even the broker only sees what it needs.
- Google refresh tokens live in the macOS Keychain (service `marsclaw`) or `data/secrets/*.txt` (0600) on Linux; both are blocked from the agent's file tools by the sensitive-path guard.

This is enforced by **process boundaries + policy**, not by the kernel. It's strong against the prompt-injection threat (the agent can only act through the broker's validated API). It does not stop host-level compromise.

## The four capability flags

Every meaningful capability is **off by default**. Re-enabling each one explicitly reopens a specific attack surface — the doc tells you which.

| Flag (data/config.json) | Env override | Default | What turning it on costs you |
|---|---|---|---|
| `allow_shell` | `MARSCLAW_ALLOW_SHELL=1` | `false` | The Bash tool re-appears. A denylist can't make shell safe against injection (`cat .e''nv`, `python -c`, `base64` all bypass any pattern). Treat as the most expensive flag. |
| `allow_web` | `MARSCLAW_ALLOW_WEB=1` | `false` | `WebFetch` and `WebSearch` become available. Without an allow-list (next row), `WebFetch` can reach any host — i.e. an exfiltration channel. |
| `allowed_web_domains` | `MARSCLAW_ALLOWED_WEB_DOMAINS=…` | `[]` | When non-empty, `WebFetch` is gated to those hosts (with subdomains). Empty + `allow_web=true` = WebSearch works, but no WebFetch will succeed. |
| `allow_mutating_tools` | `MARSCLAW_ALLOW_MUTATING_TOOLS=1` | `false` | The agent can send mail (`gmail_send`), write Sheets, create calendar events, and call write-style `*_raw` APIs. Until enabled, these refuse with a clear message instead of running. |

The **secure default posture** (all flags off) makes a prompt-injected agent have *no* third-party egress path: shell can't run, web can't fetch, mutations can't act, the channel allow-lists keep replies to the owner. The worst a successful injection can do is make the bot say something wrong to you.

### How to enable web safely

```jsonc
// data/config.json
{
  "allow_web": true,
  "allowed_web_domains": [
    "wikipedia.org",            // matches en.wikipedia.org, simple.wikipedia.org, ...
    "developer.mozilla.org",
    "github.com",
    "stackoverflow.com",
    "stackexchange.com",
    "*.gov.lk",                  // wildcard form is equivalent: "gov.lk" works the same
    "news.ycombinator.com"
  ]
}
```

A bare entry (`wikipedia.org`) matches the apex and any subdomain. The `*.example.com` form is equivalent.

Look-alike domains (`evilwikipedia.org`) do not match. Loopback / non-`http(s)` URLs (`file:///`, `javascript:`) are always rejected by `urlHost()` — they can't sit on the allow-list as a smuggling channel.

## Sender authorisation (per channel)

The agent can only be driven by people on the allow-list. Empty list = accept all (with a per-sender warning logged so you can lock down by copy-pasting the id).

| Channel | Config key | Env override |
|---|---|---|
| WhatsApp | `allowed_jids` | `MARSCLAW_WHATSAPP_ALLOWED_JIDS` |
| Telegram | `allowed_telegram_chats` | `MARSCLAW_TELEGRAM_ALLOWED_CHATS` |
| Slack | `allowed_slack_users` | `MARSCLAW_SLACK_ALLOWED_USERS` |

When the list is non-empty, the channel handler drops messages from anyone not listed before they reach the agent loop. Logged at `warn` with the rejected id so you can decide to allow.

## Sensitive paths — off-limits regardless of `allowed_paths`

The following are blocked from the agent's file tools (`Read`/`Write`/`Edit`/`Glob`/`Grep`/`MultiEdit`/`NotebookEdit`) and from `send_file` *even when they sit inside an allowed root*. Source of truth: [src/lib/sensitive-paths.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/sensitive-paths.ts).

- `.env` — channel tokens, Google OAuth client id/secret.
- `data/config.json` — permission config (self-escalation surface).
- `data/secrets/` — Linux refresh-token fallback.
- `data/whatsapp-auth/` — Baileys session credentials.
- `data/marsclaw.db` — chat history.
- `~/.claude.json` and `~/.claude/` — Claude Code OAuth, session transcripts.
- `~/.gemini/` — Gemini CLI credentials.

### Grep / Glob recursion gate

The per-target sensitive check above only validates a tool's *root* argument; recursive tools (`Grep`, `Glob`) walk into subdirectories past that point. To close this, the gate additionally refuses any `Grep`/`Glob` whose root *contains* a sensitive subtree — for example, you can't `Grep({path: '/Users/you/marsclaw'})` because `.env` is under it. The agent has to narrow the search to a subdirectory that doesn't straddle a sensitive path (`src/`, `wiki/`, etc.).

A related quiet bypass closed at the same time: `Grep`/`Glob` without an explicit `path` argument used to default to the bot process's cwd, silently sidestepping `allowed_paths`. The default is now materialised before any gate runs.

## Web research via the `researcher` subagent

When `allow_web` is on, the executive **delegates page reads to a `researcher` subagent** defined via the SDK's `agents` option in [claude-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/claude-sdk.ts):

- `tools: ['WebFetch']` — no FS, no MCP, no conversation history.
- Its system prompt instructs it that fetched pages are untrusted and to return a brief answer (not raw page text).
- The executive's persona is updated to treat the researcher's output as quotable reference material, never as instructions.

This is the "empty room" pattern: even if a fetched page tries to hijack the researcher, there are no credentials or files in its context to steal — and the URL allowlist bounds where it can reach. It does **not** fully solve indirect prompt injection (summary poisoning remains theoretically possible); the real backstop is that the executive itself has no dangerous capability to misuse when its other flags are off.

## Audit log

Every tool decision — allow, deny, or `blocked` (mutation gate refusal) — is appended as one JSON line to `logs/audit.log` by [src/lib/audit-log.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/audit-log.ts). Override the path with `MARSCLAW_AUDIT_LOG`.

Each record:

```jsonc
{
  "ts": "2026-05-28T10:11:12.345Z",
  "pid": 24135,
  "tool": "WebFetch",                          // or "Bash", "mcp__marsclaw__gmail_send", ...
  "decision": "deny",                          // "allow" | "deny" | "blocked"
  "layer": "url-allowlist",                    // which gate decided
  "subject": "https://attacker.com/?leak=...", // redacted hint (URL / file path / command preview)
  "reason": "host not in allowlist"
}
```

**What this is:** a local, append-only forensic trail. If you ever suspect something happened, you can answer "what did the agent try to do, and what did each gate block?"

**What it isn't:** tamper-resistant against host-level compromise. Same disk, same user. A real tamper-evident audit needs a remote sink (syslog, an external service), which is the point at which you've outgrown a personal bot.

Concurrent writes from the main process and the MCP child are safe — `O_APPEND` is atomic below `PIPE_BUF` (4 KB), which JSON Lines comfortably fit under.

```bash
# Inspect denials in the last day
grep '"decision":"deny"' logs/audit.log | tail
# All mutation-gate blocks
grep '"layer":"mutation-gate"' logs/audit.log
# Everything WebFetch did
grep '"tool":"WebFetch"' logs/audit.log
```

## Why the bot can't approve permission changes from chat

Approval-via-chat (the agent sends "tap yes to allow X" and the user replies "yes") sounds convenient and is a **deliberately omitted feature**. The reasoning matters:

The thing asking for approval is the *potentially-compromised* agent. A hijacked turn composes a persuasive approval message ("Tap yes to finish your request ✅") next to an attacker-controlled URL. The human is now manually auditing an opaque string for encoded exfiltration — exactly where human judgment is weakest. Approval fatigue compounds it.

Instead, when something is blocked, the audit log records it and the agent tells the user the precise `data/config.json` edit + restart needed. Permission changes flow through the operator on a real keyboard, not through a chat reply. That sacrifices polish for a meaningful security property.

## Blast-radius containment (the NemoClaw-style layer)

All opt-in. Each shrinks what a compromised agent can *do*, independent of what it reads.

### Egress gateway — `tools/egress-gateway/`

An SSRF-protected forward proxy ([gateway.ts](https://github.com/deBilla/marsclaw/blob/main/tools/egress-gateway/gateway.ts)). HTTPS via CONNECT tunnel, plain HTTP via absolute→origin rewrite. It resolves every target host and refuses to connect if any resolved IP is loopback, RFC1918, CGNAT, link-local (incl. `169.254.169.254` cloud metadata), or multicast/reserved — resolving once and pinning the IP to kill DNS-rebinding. The classifier ([ssrf.ts](https://github.com/deBilla/marsclaw/blob/main/tools/egress-gateway/ssrf.ts)) fails closed. Every decision is audited.

When `egress_mode: "gateway"` **and** egress is actually enforced (see platform constraint), the per-host URL allow-list is bypassed — the gateway is the boundary instead. Loopback / non-`http(s)` URLs are still rejected at the gate.

### LLM credential isolation — `tools/llm-proxy/`

The agent subprocess is launched with a curated env ([claude-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/claude-sdk.ts) `agentSubprocessEnv`) when `MARSCLAW_LLM_PROXY_URL` + `MARSCLAW_LLM_PROXY_TOKEN` are set: the real `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` are stripped and replaced with a rotatable session token pointed at the local proxy. A prompt-injected agent running `Bash("env")` finds only the session token, useless anywhere but the proxy. The proxy holds the real credential and forwards only `/v1/messages|models|complete`.

### Kernel sandbox — `tools/sandbox/`

- **macOS**: `marsclaw.sb` — a deny-default `sandbox-exec` profile. Credential paths (`.env`, `~/.claude.json`, `~/.gemini`, Keychain, `~/.ssh`) are denied at the kernel, so `allow_shell=true` no longer means "shell can `cat .env`".
- **Linux**: `run-linux.sh` — bubblewrap with tmpfs `$HOME` (credentials don't exist in the namespace), read-only system + source, dropped caps; `seccomp.json` denies `ptrace`/`mount`/`setns`/`bpf`/… .

### Per-call mutation approval — `mutation_approval: "all"`

Every mutating tool ([mutation-gate.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/mutation-gate.ts)) blocks and the **broker** (not the agent) sends the operator a structured prompt rendered from the tool's real parameters, plus a random nonce ([approval-gate.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/approval-gate.ts)). The operator replies the nonce; it's intercepted in the main-process dispatcher *before* the agent loop, so the agent can neither author the prompt, generate the nonce, nor see the reply. This is the chat-native form of operator approval — it sidesteps the "injected agent composes a persuasive approval message" failure of naive tap-yes-in-chat because the rendering is done by trusted code from structured fields.

## The honest platform constraint

"All traffic must traverse the gateway" is a **kernel** property:
- **Linux** — a network namespace whose only route is the gateway makes it airtight. (Scaffolded in `run-linux.sh`; validate on a real Linux host before relying on it.)
- **macOS** — no netns. Enforcement is the `pf` packet-filter anchor (`tools/sandbox/pf-anchor.conf`), which drops outbound from the bot's user except to the gateway + DNS. Proxy env vars are only a hint (Node's fetch ignores them). **Therefore the URL allow-list is relaxed only when `MARSCLAW_EGRESS_ENFORCED=1`** — an operator assertion you set *after* installing and verifying the pf anchor. Without it, the allow-list stays the boundary (fail-safe).

## Configuration cheatsheet — postures

### Locked down (default after fresh install)
Everything off. No third-party egress at all. The bot can still read your Gmail/Drive/Calendar, summarise content for you, run the assistant loop — it just can't act outwardly.

```jsonc
// effectively the defaults — no need to add these unless you want to be explicit
{
  "allow_shell": false,
  "allow_web": false,
  "allow_mutating_tools": false
}
```

### Personal-assistant useful (recommended starting point)
Web on with a tight allow-list, mutations and shell still off. Bot can search and read approved pages; still can't send mail or run shell.

```jsonc
{
  "allow_web": true,
  "allowed_web_domains": ["wikipedia.org", "developer.mozilla.org", "github.com", "stackoverflow.com"]
}
```

### Trusted operator
Mutations on too — the bot can send email, write Sheets, create calendar events. Shell stays off (don't enable unless you really need it).

```jsonc
{
  "allow_web": true,
  "allowed_web_domains": [/* ... */],
  "allow_mutating_tools": true
}
```

### Contained (NemoClaw-style — maximum capability, contained blast radius)
The point of the containment layer: open the inputs *because* the consequences are contained. Web wide open, mutations gated per-call instead of all-or-nothing, egress forced through the SSRF gateway, credentials isolated, agent sandboxed.

```jsonc
// data/config.json
{
  "allow_web": true,
  "allowed_web_domains": [],          // relaxed: the gateway is the boundary
  "egress_mode": "gateway",
  "mutation_approval": "all"          // per-call approval supersedes allow_mutating_tools
}
```

Then run hardened (`bun run service install --hardened`) with `EGRESS_GATEWAY=1`, `LLM_PROXY=1`, `SANDBOX=1`, and — on macOS, after `sudo tools/sandbox/install-pf-anchor.sh` — `MARSCLAW_EGRESS_ENFORCED=1`. With egress contained you can even consider `allow_shell: true`, since the sandbox denies the credential paths shell would otherwise reach.

## Residual risks (honest list)

In rough order of how much they matter:

1. **Supply chain** — the SDK and every dep run in-process as you. The `bun.lock` file is the only line of defence between an audited dependency closure and a fresh install; the install path (`setup.sh`) is hardened to use `--frozen-lockfile`, a pinned bun version (`BUN_VERSION`), and a SHA-256-verified nvm installer, but a compromise of any leaf in the closure still runs as you.
2. **`yt-dlp` is a security boundary**, not a trusted dependency. It runs as the bot's user and parses attacker-influenced YouTube payloads (a YouTube link the user forwarded). Setup pins it to a validated version (`YTDLP_PIN` in `src/cli/setup.ts`); bump deliberately.
3. **Enabling `allow_shell` reopens the file/credential exfil class.** A denylist cannot make shell safe; this is by design. Pair `allow_shell=true` with the `tools/sandbox/` wrapper and the `tools/llm-proxy/` sidecar for a defensible posture.
4. **Indirect prompt injection in untrusted content** — the researcher subagent and capability-removal mitigate, but a sufficiently clever poisoned summary can still influence the executive's reply. The audit-density alerter (5 denials in 60s → out-of-band ping via WhatsApp/Telegram) provides a fast operator-facing signal when an injection burst is in flight.
5. **Audit log is local-only.** A host-compromised attacker can rewrite it. Ship to a remote sink if you need real tamper-evidence.
6. **The model provider sees your context.** Inherent.
7. **No global bypass toggle.** A previous `MARSCLAW_TOOL_PERMISSIONS=bypass` escape hatch was removed — a setting whose only effect is "disable every gate" is a foot-gun (a forgotten debug toggle silently turns the bot into a credential-exfil channel). Setting that env var now logs a warning and is otherwise ignored. To loosen behaviour for a specific case, edit `data/config.json` directly.

## Where the code lives

| Concern | File |
|---|---|
| Tool permission gate (FS, shell, web, audit hooks) | [src/lib/tool-permissions.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/tool-permissions.ts) |
| Sensitive-path list + `pathContainsSensitive` | [src/lib/sensitive-paths.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/sensitive-paths.ts) |
| URL allow-list (host matching, look-alike defence) | [src/lib/url-allowlist.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/url-allowlist.ts) |
| Mutation gate (gmail_send, *_raw write methods, …) | [src/lib/mutation-gate.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/mutation-gate.ts) |
| Audit log | [src/lib/audit-log.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/audit-log.ts) |
| Researcher subagent + persona | [src/providers/claude-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/claude-sdk.ts) |
| Telegram / Slack sender allow-lists | [src/channels/telegram.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/telegram.ts), [src/channels/slack.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/slack.ts) |
| MCP child env passthrough (no Anthropic creds in broker) | [src/providers/claude-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/claude-sdk.ts) `MCP_ENV_PASSTHROUGH` |
| Egress gateway + SSRF classifier | [tools/egress-gateway/gateway.ts](https://github.com/deBilla/marsclaw/blob/main/tools/egress-gateway/gateway.ts), [ssrf.ts](https://github.com/deBilla/marsclaw/blob/main/tools/egress-gateway/ssrf.ts) |
| LLM credential isolation (curated subprocess env) | [src/providers/claude-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/claude-sdk.ts) `agentSubprocessEnv`, [tools/llm-proxy/proxy.ts](https://github.com/deBilla/marsclaw/blob/main/tools/llm-proxy/proxy.ts) |
| Per-call mutation approval | [src/lib/approval-gate.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/approval-gate.ts), [src/db/approvals.ts](https://github.com/deBilla/marsclaw/blob/main/src/db/approvals.ts), interception in [src/index.ts](https://github.com/deBilla/marsclaw/blob/main/src/index.ts) |
| Kernel sandbox + egress enforcement | [tools/sandbox/](https://github.com/deBilla/marsclaw/blob/main/tools/sandbox/) (`marsclaw.sb`, `run-*.sh`, `pf-anchor.conf`, `seccomp.json`, `launch-hardened.sh`) |
| Audit-density alerting | [src/lib/audit-log.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/audit-log.ts) `registerAuditAlerter` |

For the comparison against the multi-tenant alternative — when in-process is enough vs. when you need a container — see [vs-nanoclaw.md](vs-nanoclaw.md).
