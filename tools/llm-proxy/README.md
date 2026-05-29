# LLM credential-isolation proxy (stub)

Today the agent process holds the real Anthropic credential (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`) in its env. A successful prompt injection that gets shell or arbitrary file read can exfiltrate it. The [security doc](../../docs/security.md) acknowledges this as a residual risk; this sidecar closes it.

## How it works

```
agent process                          llm-proxy (this dir)            api.anthropic.com
 ANTHROPIC_BASE_URL=                    127.0.0.1:8765
   http://127.0.0.1:8765                  - verifies session token
 ANTHROPIC_API_KEY=                       - swaps in real cred
   <session-token>             ─────►    - logs request           ─────►
                                         - (hook) PII redact
                                         - (hook) per-day budget
```

The agent only ever sees a rotatable **session token**. Compromising the agent process gives the attacker that session token, which:

1. Only works against the proxy (which only forwards a narrow set of paths).
2. Can be rotated independently — change `LLM_PROXY_SESSION_TOKEN` in two places (proxy env + agent env) and the attacker's stolen value is dead.
3. Cannot be used to call any Anthropic endpoint outside `/v1/messages`, `/v1/models`, `/v1/complete`.

## Running it

```bash
# 1. Mint a session token (any opaque string; rotate freely).
SESSION_TOKEN=$(openssl rand -hex 32)

# 2. Start the proxy with the real credential in its env, NOT the agent's.
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
LLM_PROXY_SESSION_TOKEN="$SESSION_TOKEN" \
bun run tools/llm-proxy/proxy.ts

# 3. Run marsClaw with the agent pointed at the proxy and holding only the
#    session token.
ANTHROPIC_BASE_URL="http://127.0.0.1:8765" \
ANTHROPIC_API_KEY="$SESSION_TOKEN" \
bun run start
```

For OAuth (Claude Pro/Max subscription mode), set `CLAUDE_CODE_OAUTH_TOKEN` on the proxy instead of `ANTHROPIC_API_KEY`. The SDK will still send the session token over to the proxy as an `Authorization: Bearer` header; the proxy swaps it for the real OAuth.

## Wiring into launchd / systemd

Two units instead of one. The proxy is the parent dependency; the agent depends on it.

**macOS launchd** — create a second plist `com.marsclaw.llm-proxy.plist` for the proxy. Edit [`launchd/com.marsclaw.plist`](../../launchd/com.marsclaw.plist) to set the env vars above. Both `bun run service install` and a one-liner `launchctl bootstrap gui/$UID …` work.

**Linux systemd** — `marsclaw-proxy.service` with `Requires=` and `After=marsclaw-proxy.service` on the main unit.

## What's deliberately a stub

- **No PII redaction.** `redact()` is a no-op hook. Plug a regex sweep (emails, phone numbers, refresh-token shapes) before forwarding if your model provider's logs are a concern.
- **No per-thread budget.** [src/lib/cost-tracker.ts](../../src/lib/cost-tracker.ts) does this in-process today; moving it here means it survives an agent compromise. Read the upstream response's `usage` block and reject 429-shaped responses upstream when over budget.
- **Buffered body forwarding.** The stub reads the full upstream response into memory before returning. For streaming (SSE), proxy through a `ReadableStream` and tee bytes to the log line.
- **No mTLS / Unix socket option.** Loopback TCP is fine on a single-user host; multi-user boxes should expose this over a Unix socket with `0600` perms instead.
- **Gemini.** The Gemini CLI uses OAuth-via-browser auth, not a static bearer. Wrapping it requires intercepting the OAuth flow — not done here.
