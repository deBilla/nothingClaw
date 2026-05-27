# Architecture

marsClaw is one Bun process. SQLite is the only persistent state. The agent SDK does the LLM work; we glue channels and tools to it.

## Message flow

```
┌────────────────────────────┐         ┌──────────────────────────────────────┐
│  channel adapter           │ text ─▶ │  handleMessage (src/agent.ts)        │
│  · telegram                │         │  · append to sqlite messages         │
│  · slack                   │         │  · build per-turn context            │
│  · whatsapp                │ audio?▶ │     (time, timezone, location)       │
└────────────────────────────┘ whisper │  · runClaudeSdk OR runGeminiSdk      │
        ▲                      :9000   │  · trim reply, append, send          │
        │                              └────────────┬─────────────────────────┘
        │                                           │
        │                          speak / send_file│   ← MCP (stdio)
        │                          send_message     │
        │                          gmail/calendar…  │
        │                                           ▼
        └──────────  router.send  ◀──── outbox drain (250ms / 5s tick)
```

Single dispatcher in [src/index.ts](https://github.com/deBilla/marsclaw/blob/main/src/index.ts) serializes per thread: two messages from the same chat never run two agent calls in parallel. The outbox is the only path for asynchronous side-channel messages — the agent's MCP tools enqueue rows, the drain loop delivers them.

## Components

| Layer                       | Where                                                     | Notes |
|---|---|---|
| Process root                | [src/index.ts](https://github.com/deBilla/marsclaw/blob/main/src/index.ts)                           | Boots channels, drain loop, health server, backup schedule. |
| Per-turn handler            | [src/agent.ts](https://github.com/deBilla/marsclaw/blob/main/src/agent.ts)                           | Picks provider, runs it, catches errors, manages typing. |
| Channel router              | [src/channels/router.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/router.ts)       | Dispatches by thread-id prefix: `telegram:`, `slack:`, `whatsapp:`. |
| Channel adapters            | [src/channels/](https://github.com/deBilla/marsclaw/blob/main/src/channels/)                         | One file per channel. Implements the `Channel` interface. |
| Provider registry           | [src/providers/registry.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/registry.ts) | Selects Claude or Gemini from `agent_provider`. |
| Claude path                 | [src/providers/claude-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/claude-sdk.ts) | Long-lived `query()` per thread via `@anthropic-ai/claude-agent-sdk`. LRU cap. |
| Gemini path                 | [src/providers/gemini-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/gemini-sdk.ts) | In-process inference via `@google/gemini-cli-core`. |
| MCP server                  | [src/mcp/server.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/server.ts)                 | stdio MCP exposing channel + Google tools to the agent. |
| Per-call tool gate          | [src/lib/tool-permissions.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/tool-permissions.ts) | `allowed_paths` enforcement + Bash denylist. |
| SQLite                      | [src/db/](https://github.com/deBilla/marsclaw/blob/main/src/db/)                                     | `messages`, `outbox`, `sessions` tables. |
| Config                      | [src/lib/config.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/config.ts)                 | `data/config.json` + env overlay, read once. |

## Thread IDs

Every channel writes thread IDs prefixed with its name. The router dispatches outbound sends back to the right adapter using that prefix.

| Channel    | Format example                              |
|---|---|
| Telegram   | `telegram:123456789`                        |
| Slack      | `slack:C0123456789`                         |
| WhatsApp   | `whatsapp:94701234567@s.whatsapp.net`       |

## SQLite schema

`data/marsclaw.db` (override with `MARSCLAW_DB`). Migrations live in [migrations/](https://github.com/deBilla/marsclaw/blob/main/migrations/) and run on every boot.

**messages**

| col | type | notes |
|---|---|---|
| id | INTEGER PK | autoincrement |
| thread_id | TEXT | channel-prefixed |
| role | TEXT | `user` or `assistant` |
| text | TEXT | raw (no per-turn context decoration) |
| created_at | INTEGER | unix epoch |

**outbox** — async messages queued by the agent's MCP tools.

| col | type | notes |
|---|---|---|
| id | INTEGER PK | |
| thread_id | TEXT | |
| text | TEXT | reply text (or caption when `file_path` is set) |
| audio_path | TEXT? | when set, channel sends as voice note |
| file_path | TEXT? | when set, channel sends as document/image |
| file_name | TEXT? | display name override |
| attempts | INTEGER | retry counter (cap = `MAX_ATTEMPTS`) |
| delivered_at | INTEGER? | non-null when sent |
| failed_at | INTEGER? | non-null when permanently failed |
| last_error | TEXT? | last delivery error |
| created_at | INTEGER | |

**sessions** — provider session continuity (Claude SDK resume).

| col | type | notes |
|---|---|---|
| thread_id | TEXT PK | |
| provider | TEXT | `claude` |
| session_id | TEXT | resumed across restarts |
| updated_at | INTEGER | |

## Per-turn flow

1. Adapter receives a message and calls `onMessage(threadId, text)`.
2. `src/index.ts` chains the call onto an in-memory `inFlight` promise keyed by `threadId` — serialized per thread, parallel across threads.
3. `handleMessage` ([src/agent.ts](https://github.com/deBilla/marsclaw/blob/main/src/agent.ts)) appends to `messages`, builds the per-turn context block (current local time, timezone, location), and calls the selected provider.
4. **Claude path:** SDK `query()` is long-lived per thread (subprocess + MCP boot once, ~10s); subsequent messages stream into the same iterable.
5. **Gemini path:** in-process inference via `@google/gemini-cli-core`. Re-sends the last 20 turns as context each call.
6. The reply is trimmed; empty replies are skipped. Non-empty replies append to `messages` and send through the channel.
7. While the agent is thinking, a typing-indicator refresher (4s cadence) fires through `channel.setTyping`.
8. The MCP tools (`send_message`, `send_file`, `speak`, Gmail/Drive/etc.) write rows to `outbox`; a tick-based drain (250ms while draining, 5s idle) delivers them.

## What you don't see

- **Circuit breaker.** `enforceStartupBackoff` ([src/lib/circuit-breaker.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/circuit-breaker.ts)) sleeps before booting if recent restarts have been suspiciously frequent. Stops a crash loop from burning API quota.
- **Heartbeat file.** The provider touches `data/heartbeat` while a turn is in flight. The typing refresher and external monitors read it.
- **Cost tracker.** [src/lib/cost-tracker.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/cost-tracker.ts) sums `SDKResultSuccess.total_cost_usd` per day. New turns refuse if today's spend exceeds `daily_usd_budget` — but only on a metered Anthropic API key; Claude Pro/Max OAuth bypasses the check (no per-token billing).
- **Conversation archive.** [src/lib/conversation-archive.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/conversation-archive.ts) keeps a JSONL transcript per thread under `data/conversations/`.
- **Backups.** [src/lib/backup.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/backup.ts) snapshots `marsclaw.db`, `MEMORY.md`, and `data/whatsapp-auth/` on a schedule.
- **Health server.** [src/lib/health-server.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/health-server.ts) exposes a small HTTP endpoint for liveness probes.

## What we deliberately delegate

The agent SDK owns: multi-turn tool use, planning, retries, context compaction, prompt caching (Claude), LLM auth and rate-limit handling, and the built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch). That is roughly the hardest 80% of building an agent. Anthropic's and Google's teams iterate on it daily. Outsourcing it is leverage, not laziness.
