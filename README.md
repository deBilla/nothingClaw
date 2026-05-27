# marsClaw

A personal chat agent — nothing more.

marsClaw is a single-process Bun app that connects messaging channels (Telegram, Slack, WhatsApp) to an LLM agent SDK (Gemini or Claude). Conversations land in SQLite; the chosen agent SDK handles the LLM call, tool use, and reasoning loop.

```
  ╲              ╱    marsClaw  ·  running
  │    ▄██▄     │
  │    ██████   │
  │    ▀██▀     │
  ╱              ╲    provider: claude  ·  channels: whatsapp, telegram
```

## Why it's small

The whole codebase is ~5k lines of TypeScript. The hardest parts of building an agent — the reasoning loop, context compaction, the built-in tools (shell, read/write/edit, glob, grep, web fetch/search), model selection, retry logic — are delegated to the Claude Agent SDK or the Gemini CLI core. We own the chat-side glue: channel adapters, SQLite, an MCP server with channel-specific tools (`send_message`, `send_file`, `speak`, Gmail/Calendar/Drive/…), and ~5 files of context engineering.

When Anthropic or Google ship a better model or improved tool use, we get it for free. Tradeoff: we're coupled to two specific SDK shapes, and the agent runs as the host user with no per-conversation sandbox. That's fine for a personal bot; it would not be fine at a higher tier.

For a deeper comparison with the multi-tenant cousin, see [docs/vs-nanoclaw.md](docs/vs-nanoclaw.md).

## Highlights

- **Two agent SDKs, one wire format.** Pick Gemini or Claude. Switch any time with `bun run provider`. Automatic Claude→Gemini failover when Claude is over-quota.
- **Multi-channel.** Telegram, Slack (Socket Mode), WhatsApp (Baileys, QR auth). Enable any combination.
- **Voice in and out.** WhatsApp voice notes are transcribed locally (faster-whisper); replies can be spoken locally (kokoro-onnx). No cloud, no Docker.
- **Images & files.** WhatsApp images are downloaded and passed to the agent for vision. The agent can deliver files back to the user via the `send_file` MCP tool.
- **Google built-in.** OAuth-once, multiple Google accounts, MCP tools for Gmail, Calendar, Contacts, Drive, Sheets, Docs, Slides.
- **Persistent memory.** `MEMORY.md` is the agent's own long-term notebook. A `wiki/` folder holds longer structured pages.
- **Hardened defaults.** Per-thread message serialization, sandboxed `allowed_paths`, bash denylist, inbound rate limits, daily USD budget cap, circuit-breaker startup backoff, automatic DB + auth backups.
- **One-shot setup.** `bash setup.sh` walks you from a fresh checkout to a running bot in ~2 minutes.

## Quick start

```bash
git clone <your-fork-url> marsclaw
cd marsclaw
bash setup.sh
```

Setup walks you through name/timezone/location, provider (Gemini or Claude), one-time browser login (auto-detected and skipped if already authed), channel selection, and WhatsApp linking. At the end it offers to start the bot for you.

To start it later:

```bash
bun run start
```

## Commands

```bash
bun run setup                       # rerun setup (idempotent)
bun run start                       # start the bot
bun run status                      # provider, db stats, recent threads
bun run provider [gemini|claude]    # switch agent provider
bun run whatsapp <sub>              # reset | status | clear-media
bun run voice <sub>                 # install | start | stop | status
bun run google <sub>                # login | status | logout | test
bun run service <sub>               # launchd: install | start | stop | logs
bun run path <sub>                  # manage agent allowed_paths
bun run usage <sub>                 # Anthropic spend (today | week | by-thread)
bun run backup                      # one-shot backup
bun run db <sub>                    # stats | vacuum | integrity
bun run update                      # pull, install, restart service
bun run smoke [prompt]              # fire a synthetic message end-to-end
```

## Documentation

Browse the docs site at **<https://deBilla.github.io/marsClaw/>** — or read the markdown directly in [docs/](docs/):

- [docs/architecture.md](docs/architecture.md) — message flow, components, SQLite schema, per-thread serialization
- [docs/configuration.md](docs/configuration.md) — `.env` and `data/config.json` reference, precedence rules
- [docs/channels.md](docs/channels.md) — per-channel setup: Telegram, Slack, WhatsApp
- [docs/providers.md](docs/providers.md) — Gemini vs Claude, switching, auth, costs, failover
- [docs/voice.md](docs/voice.md) — Whisper STT + Kokoro TTS sidecars, voices, model sizes
- [docs/google.md](docs/google.md) — Google OAuth (Gmail/Calendar/Drive/Sheets/Docs/Slides/Contacts)
- [docs/operations.md](docs/operations.md) — running as a launchd service, backups, observability, troubleshooting
- [docs/development.md](docs/development.md) — codebase tour, adding a channel, adding an MCP tool, tests
- [docs/vs-nanoclaw.md](docs/vs-nanoclaw.md) — when to pick marsClaw vs the multi-tenant cousin

## Requirements

- macOS or Linux (or WSL). Setup auto-installs nvm, Node (pinned LTS, default 22), and Bun — no prerequisites beyond `curl` and `bash`.
- A bot/app token from each channel you want to enable.
- **Voice (optional):** Python 3.10+ and `ffmpeg`. On macOS: `brew install python@3.11 ffmpeg`.

## Privacy

These never leave your machine and are all gitignored:

- `.env` — channel tokens, API keys
- `data/` — SQLite DB, WhatsApp linked-device auth, downloaded media
- `MEMORY.md`, `wiki/` — anything the agent has noted about you

The agent SDK's own credentials live in your home directory (`~/.gemini/`, `~/.claude.json`), not in this repo. Google OAuth refresh tokens are stored in the macOS Keychain (or 0600 fallback files on Linux), never in `.env`.

## License

MIT.
