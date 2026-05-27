# Providers

marsClaw runs against one of two agent runtimes per chat. Switch any time without code changes.

| Provider | Runtime                                | Auth                                       | Tools                                                                 |
|---|---|---|---|
| `claude` | `@anthropic-ai/claude-agent-sdk`       | Claude OAuth (Pro/Max) or `ANTHROPIC_API_KEY` | Bash, Read, Write, Edit, MultiEdit, Glob, Grep, WebFetch, WebSearch + our MCP suite |
| `gemini` | `@google/gemini-cli-core` (in-process) | Gemini OAuth (free tier) or `GEMINI_API_KEY`   | Text only — no tool calling on this path                              |

## Switching providers

```bash
bun run provider              # interactive
bun run provider claude
bun run provider gemini
```

Writes `agent_provider` to `data/config.json`. Restart isn't required — the change is picked up on the next message. The `AGENT_PROVIDER` env var overrides the config file if set.

## Claude

Implementation: [src/providers/claude-sdk.ts](../src/providers/claude-sdk.ts).

### How it works

- **One long-lived `query()` per thread.** The SDK boots a subprocess + MCP server (~10s) on first message, then each new turn pushes an `SDKUserMessage` into the same async iterable. Cold-start is paid once per chat, not per message.
- **Session continuity.** The SDK persists the transcript to `~/.claude`. If a session is recycled (idle timeout, crash), the next message resumes from the stored `session_id`.
- **Capacity.** Sessions are kept in an LRU map capped at `config.max_sessions` (default 20). A flood of new threads cannot OOM the host.
- **Idle / age teardown.** Sessions are recycled after `idle_ms` of inactivity (default 15 min) or `max_session_age_ms` total lifetime (default 4 h), whichever first. Hard cap exists to bound slow leaks in the SDK subprocess / MCP child / third-party deps.

### Auth

```bash
claude   # interactive login the first time
```

Subsequent `claude` invocations reuse the token. marsClaw's setup auto-detects this. For headless / metered usage:

```env
ANTHROPIC_API_KEY=sk-ant-…
```

### Tool gate

Every tool call passes through [src/lib/tool-permissions.ts](../src/lib/tool-permissions.ts):

- Filesystem-touching tools (`Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `NotebookEdit`) are restricted to `allowed_paths`.
- `Bash` adds the destructive-command denylist (`rm -rf /`, `chmod 000`, `dd of=`, fork bombs, `mkfs`, `shred`) plus your `extra_bash_denylist`.
- Write-style tools auto-`mkdir -p` the parent directory so the agent doesn't need a separate Bash step.
- A `Write/Edit` outside `allowed_paths` returns a deny with a clear message; the agent reads it and adjusts.

The same gate hides Claude-Code-UI-only tools (`TodoWrite`, `ScheduleWakeup`, `EnterPlanMode`, …) that don't belong in chat mode.

### Cost tracking

[src/lib/cost-tracker.ts](../src/lib/cost-tracker.ts) sums `SDKResultSuccess.total_cost_usd` per day. New turns refuse once spend exceeds `daily_usd_budget` (config.json). The check is auto-skipped under Claude Pro/Max OAuth — there's no per-token billing.

Inspect:

```bash
bun run usage today
bun run usage week
bun run usage by-thread
```

### Failover

If Claude returns a "hard error" — quota exhausted, auth broken — and Gemini is authed, marsClaw fails over to Gemini for that turn so the user still gets an answer:

```
[claude] hard error — failing over to gemini
```

Hard errors are classified in [src/providers/claude-error.ts](../src/providers/claude-error.ts).

## Gemini

Implementation: [src/providers/gemini-sdk.ts](../src/providers/gemini-sdk.ts).

### How it works

- **In-process inference.** Reuses the OAuth credentials at `~/.gemini/oauth_creds.json` that the `gemini` CLI writes. No subprocess.
- **Per-thread chat history kept in memory** and re-sent on each turn (last 20 turns), so we don't fight the SDK's chat-state model.
- **No tool calling.** Same scope as the old `gemini -p` shell-out. Use Claude if you need shell, file edits, or web browsing in the agent loop.

### Auth

```bash
gemini   # interactive login the first time → ~/.gemini/oauth_creds.json
```

Or use a paid API key (higher quota, no daily reset):

```env
GEMINI_API_KEY=…
```

### Model

`GEMINI_MODEL=gemini-2.5-flash` by default. Override in `.env`.

### Quota

Gemini OAuth free tier has a daily quota that resets every 16–24h. When exhausted the bot replies with a friendly note instead of going silent:

> I've hit my daily Gemini quota. Try again later or switch providers (`bun run provider claude`).

Errors are classified in [src/agent.ts](../src/agent.ts) (`geminiFriendlyError`).

## Comparison

| | Claude | Gemini |
|---|---|---|
| Tool use | ✓ shell, fs, web | ✗ text only |
| Image input | ✓ via `Read` of a downloaded path | ✗ |
| Cold start | ~10s once per chat | ~10s once per process |
| Per-message latency | ~1–5s warm | ~1–3s warm |
| Free tier | Claude.ai subscription gives Claude Code OAuth | Generous daily free quota, OAuth |
| Cost ceiling | `daily_usd_budget` enforces a cap (metered only) | Quota is upstream-imposed |
| Failover target | Gemini, when authed | none |
