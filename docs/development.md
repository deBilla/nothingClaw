# Development

## Layout

```
marsclaw/
├── src/
│   ├── index.ts            # process root: channels + dispatcher + outbox drain
│   ├── agent.ts            # per-message handler: picks provider, runs it
│   ├── voice.ts            # voice helper utilities
│   │
│   ├── channels/
│   │   ├── router.ts       # dispatch outbound by thread-id prefix
│   │   ├── types.ts        # Channel interface
│   │   ├── telegram.ts     # node-telegram-bot-api
│   │   ├── slack.ts        # @slack/bolt, Socket Mode
│   │   ├── whatsapp.ts     # baileys (the big one)
│   │   └── whatsapp-link.ts# one-shot owner pairing
│   │
│   ├── providers/
│   │   ├── registry.ts     # pickProvider()
│   │   ├── types.ts        # Provider interface
│   │   ├── claude-sdk.ts   # @anthropic-ai/claude-agent-sdk path
│   │   ├── claude.ts       # bin + isAuthed metadata
│   │   ├── claude-error.ts # classify hard vs transient errors
│   │   ├── gemini-sdk.ts   # @google/gemini-cli-core in-process path
│   │   └── gemini.ts       # bin + isAuthed metadata
│   │
│   ├── mcp/
│   │   ├── server.ts       # stdio MCP server (all tools registered here)
│   │   ├── send.ts         # send_message
│   │   ├── send_file.ts    # send_file (with allowed_paths gate)
│   │   ├── speak.ts        # kokoro TTS → outbox row with audio_path
│   │   ├── gmail.ts        # gmail_recent / search / get / send
│   │   ├── contacts.ts     # contacts_search
│   │   ├── calendar.ts     # list / create / raw
│   │   ├── drive.ts        # search / read / raw
│   │   ├── sheets.ts       # read / write / raw
│   │   ├── docs.ts         # read / raw
│   │   ├── slides.ts       # read / raw
│   │   └── google_accounts.ts
│   │
│   ├── google/
│   │   ├── auth.ts         # OAuth installed-app flow, multi-account
│   │   ├── keychain.ts     # macOS Keychain wrapper + 0600 fallback
│   │   ├── clients.ts      # googleapis client factories
│   │   ├── contacts.ts     # People API helpers
│   │   ├── gmail.ts        # Gmail helpers shared by MCP tool
│   │   └── raw.ts          # raw HTTP escape hatch
│   │
│   ├── db/
│   │   ├── connection.ts   # bun:sqlite open + WAL pragmas
│   │   ├── messages.ts     # append / load history
│   │   ├── outbox.ts       # take / mark delivered / mark failed
│   │   ├── sessions.ts     # provider session_id per thread
│   │   └── migrations.ts   # run migrations/*.sql on boot
│   │
│   ├── lib/
│   │   ├── config.ts       # config.json + env precedence
│   │   ├── env.ts          # .env loader
│   │   ├── log.ts          # pino-shaped logger
│   │   ├── log-rotate.ts
│   │   ├── tool-permissions.ts  # canUseTool gate (allowed_paths, bash denylist)
│   │   ├── turn-context.ts # per-turn ambient context (time/tz/location)
│   │   ├── typing.ts       # typing indicator refresher
│   │   ├── attachment-safety.ts
│   │   ├── command-gate.ts
│   │   ├── circuit-breaker.ts   # startup backoff after crashes
│   │   ├── rate-limit.ts        # per-sender token bucket
│   │   ├── cost-tracker.ts      # daily Anthropic spend cap
│   │   ├── conversation-archive.ts # JSONL transcript per thread
│   │   ├── heartbeat.ts         # data/heartbeat for stuck-turn detection
│   │   ├── health-server.ts     # HTTP liveness endpoint
│   │   ├── backup.ts            # daily DB + MEMORY.md + WA auth backup
│   │   ├── launchd.ts           # launchctl wrappers
│   │   ├── atomic.ts            # writeAtomic
│   │   └── timezone.ts
│   │
│   └── cli/
│       ├── index.ts        # subcommand router
│       ├── setup.ts        # interactive bootstrap
│       ├── status.ts
│       ├── provider.ts
│       ├── whatsapp.ts
│       ├── voice.ts
│       ├── google.ts
│       ├── service.ts      # launchd install/start/stop
│       ├── path.ts         # allowed_paths management
│       ├── backup.ts
│       ├── db.ts
│       ├── usage.ts        # anthropic spend
│       ├── update.ts       # git pull + install + restart
│       ├── smoke.ts        # synthetic message
│       └── branding.ts     # the marsClaw ASCII banner
│
├── tools/                  # python sidecars (voice)
│   ├── whisper-server.py
│   ├── kokoro-server.py
│   └── setup-voice.sh
│
├── migrations/             # SQL, run on every boot
├── tests/                  # bun test
├── skills/                 # @skills/<name>.md sub-instructions
├── wiki/                   # optional structured knowledge base
├── data/                   # gitignored runtime state
├── logs/                   # gitignored
├── launchd/                # plist template
├── docs/                   # you are here
├── CLAUDE.md               # agent persona (Claude)
├── GEMINI.md               # agent persona (Gemini)
├── MEMORY.md               # agent's own notes (gitignored)
└── MEMORY.template.md      # seed copied on first run
```

## Local dev loop

```bash
bun install
bun run setup        # if .env / data/config.json don't exist yet
bun run start        # foreground

bun run typecheck    # tsc --noEmit
bun run lint
bun run lint:fix
bun run format
bun test             # all tests; LOG_LEVEL=error to suppress noise
bun test --watch
```

A husky pre-commit hook runs Prettier + ESLint; CI lives in [.github/workflows/](../.github/workflows/).

## Tests

In [tests/](../tests/). Notable ones:

| File | What it covers |
|---|---|
| `attachment-safety.test.ts` | inbound media validation |
| `circuit-breaker.test.ts`   | startup backoff math |
| `claude-error.test.ts`      | hard-error classification |
| `command-gate.test.ts`      | bash denylist patterns |
| `conversation-archive.test.ts` | JSONL transcript writes |
| `cost-tracker.test.ts`      | daily spend math + budget gate |
| `migrations.test.ts`        | sql migrations run, idempotent |
| `outbox.test.ts`            | take/deliver/fail semantics |
| `rate-limit.test.ts`        | per-sender token bucket |
| `tool-permissions.test.ts`  | `allowed_paths` + bash denylist via `canUseTool` |

## Adding a channel

1. Add a file under [src/channels/](../src/channels/) that exports `create<Name>Channel({ ..., onMessage }): Channel`.
2. Use `<name>:<upstream-id>` for thread IDs — the router dispatches outbound sends back to you by that prefix.
3. Wire it up in [src/index.ts](../src/index.ts) behind a feature flag (env var or `data/config.json` field).
4. Implement `setTyping` if the upstream supports it. Channels without it get a no-op.

`SendOpts` supports `audioPath` (voice notes) and `filePath` + `fileName` (file delivery). Implement what your channel can render; the rest is sent as plain text.

## Adding an MCP tool

1. Add a file in [src/mcp/](../src/mcp/) exporting `{ definition, handler }` shaped like the existing tools.
2. Register it in [src/mcp/server.ts](../src/mcp/server.ts) — add to the `tools` array.
3. If your tool writes to the outbox, follow [send_file.ts](../src/mcp/send_file.ts) — load `MARSCLAW_THREAD_ID` from env, validate paths against `loadConfig().allowed_paths`.
4. If your tool calls a Google API, get an authed client via [src/google/clients.ts](../src/google/clients.ts).

Restart the bot. The agent will discover the new tool via the standard MCP list-tools handshake.

## Adding a provider

1. Add a file in [src/providers/](../src/providers/) that exports a `Provider` per [src/providers/types.ts](../src/providers/types.ts):

   ```ts
   export const myprovider: Provider = {
     name: 'myprovider',
     bin: process.env.MYPROVIDER_BIN ?? 'myprovider',
     npmPackage: '@vendor/myprovider-cli',
     buildArgs(prompt) { return ['-p', prompt]; },
     isAuthed() { /* synchronous, side-effect-free */ },
   };
   ```

2. Add a `run<Provider>Sdk(...)` if your provider is an SDK (preferred — avoids subprocess cold-start).
3. Wire both into [src/providers/registry.ts](../src/providers/registry.ts) and the `agent_provider` union in [src/lib/config.ts](../src/lib/config.ts).
4. Add a branch in [src/agent.ts](../src/agent.ts) and a friendly-error mapper if your provider has rate-limit quirks.

## Personas

Two files, identical purpose, kept separately because the upstream SDKs read different filenames:

- [GEMINI.md](../GEMINI.md) — read by `@google/gemini-cli-core`
- [CLAUDE.md](../CLAUDE.md) — read by `@anthropic-ai/claude-agent-sdk`

Setup keeps them in sync. If you tweak one, mirror to the other.

## Migrations

Drop a new file in [migrations/](../migrations/) with the next sequential number (`0005_…sql`). It runs on the next boot via [src/db/migrations.ts](../src/db/migrations.ts), which uses `user_version` as the cursor. Migrations are append-only; once shipped, never edit a previous file — write a new one.

## Style

- TypeScript strict mode, `bun:sqlite`, ESLint flat config, Prettier.
- Comments are sparse but real: when there's a non-obvious reason for code, the comment explains *why* (an incident, an invariant, an upstream quirk). Mimic the style of existing files.
- No try-catch-all (`eslint-plugin-no-catch-all` enforces this). Catch specific types.
- Tests use Bun's built-in runner (`bun test`).
