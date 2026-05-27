# marsClaw

A personal chat agent — nothing more.

marsClaw is a single-process Bun app that connects messaging channels (Telegram, Slack, WhatsApp) to an agent CLI (Gemini CLI or Claude Code). Messages route through SQLite; the chosen agent CLI handles the LLM call, tools, and reasoning loop.

```
  ╲ ╲ ╲    marsClaw  ·  running
   ╲ ╲ ╲   provider: gemini  ·  channels: telegram, whatsapp
```

## Features

- **Two agent CLIs, one wire format.** Pick Google's Gemini CLI or Anthropic's Claude Code. Switch any time with `bun run provider`.
- **Multi-channel.** Telegram, Slack (Socket Mode), WhatsApp (Baileys, QR auth). Enable any combination.
- **Image support.** WhatsApp images are downloaded and passed to the agent via `@<path>` for vision.
- **Voice in and out (optional).** WhatsApp voice notes are transcribed by a local Whisper sidecar; the agent can reply with synthesized speech via a local Kokoro sidecar. No cloud, no Docker.
- **MCP tools — `send_message`, `speak`.** For proactive / multi-part replies and voice synthesis. Add more by dropping files into `src/mcp/`.
- **Per-thread serialization.** Two messages from the same chat can never race two agent subprocesses.
- **Auto-detected login.** If you've already authed `gemini` or `claude` in another terminal, setup skips the login step.
- **Persistent agent memory.** `MEMORY.md` is editable by the agent itself for long-term recall.

## Requirements

- macOS or Linux (or WSL). Setup auto-installs nvm, Node (pinned LTS, default 22), and Bun — no prerequisites beyond `curl` and `bash`.
- A bot/app token from each channel you want to enable.
- **Voice (optional):** Python 3.10+ and `ffmpeg`. On macOS: `brew install python@3.11 ffmpeg`.

## Quick start

```bash
git clone <your-fork-url> marsclaw
cd marsclaw
bash setup.sh
```

Setup walks you through:

1. **Your name, location & timezone.** Lets the agent answer time/location-aware questions ("what's on my schedule today?") in your local time instead of UTC.
2. **Pick an agent CLI.** Gemini CLI or Claude Code — auto-installs from npm if missing.
3. **One-time browser login.** Auto-detected and skipped if you're already authed.
4. **Connect channels.** Telegram, Slack, WhatsApp — any combination, all optional.
5. **Link WhatsApp.** Scan the QR right in the setup flow — no need to start the bot first.

At the end, setup offers to **start the bot for you** so the WhatsApp pairing code is captured live — just send the code it prints from your phone. To start it yourself later:

```bash
bun run start
```

If WhatsApp wasn't linked during setup, scan the QR printed on start:
**WhatsApp on phone → Settings → Linked devices → Link a device**.

## Commands

```bash
bun run setup                       # rerun setup (idempotent)
bun run start                       # start the bot
bun run status                      # provider, db stats, recent threads
bun run provider [gemini|claude]    # switch agent provider (interactive if no arg)
bun run whatsapp reset              # clear WhatsApp auth → forces a new QR
bun run whatsapp status             # show link state + cached media count
bun run whatsapp clear-media        # purge data/whatsapp-media/
bun run voice install               # one-time: create venv, install whisper + kokoro
bun run voice start                 # start both sidecars (detached)
bun run voice status                # show whether each sidecar is running + healthy
bun run voice stop                  # stop both sidecars
```

## Architecture

```
┌───────────────────┐               ┌──────────────────────────┐
│  channel adapter  │ ── text ──▶   │  handleMessage           │
│  · telegram       │               │  · persist to sqlite     │
│  · slack          │               │  · build prompt          │
│  · whatsapp       │   audio? ──▶  │  · spawn gemini / claude │
└───────────────────┘   whisper     │  · send reply            │
        ▲               :9000       └──────────────────────────┘
        │                                       │
        │                              speak()  │  ← MCP
        │                            kokoro     │
        │                            :9001      │
        └─── router.send ◀── outbox drain ◀─────┘
```

Single process. SQLite (`data/marsclaw.db`) is the only state:

- `messages` — conversation history per thread
- `outbox` — async messages queued by the agent's `send_message` / `speak` MCP tools (text and audio share one queue via an `audio_path` column)

The agent CLI runs as a subprocess per incoming message. Its built-in tools (shell, file read/write/edit, glob, grep, web fetch/search) plus our tiny MCP server give it everything it needs. Voice support adds two optional Python sidecars (Whisper + Kokoro) on localhost — no Docker.

## Why this is small

The whole codebase is ~1500 lines of TypeScript. marsClaw is deliberately the laziest possible implementation of a personal chat agent — and that's a feature, not a shortcut.

**What we delegate to the agent CLI** (Claude Code or Gemini CLI):

- The reasoning loop — multi-turn tool use, planning, retries
- Context compaction as conversations grow
- Built-in tools — shell, file read/write/edit, glob, grep, web fetch / search
- LLM API auth, rate-limit handling, model selection
- The dozens of edge cases inside those tools (timeouts, escaping, output truncation, …)

That's the hardest 80% of building an agent, and full-time teams at Anthropic and Google work on it every day. Outsourcing it is leverage, not laziness.

**What we actually own:**

- Channel adapters (Telegram, Slack, WhatsApp) — download bytes, push bytes
- SQLite — one table for history, one for the outbox
- A ~70-line subprocess wrapper that runs `gemini -p` or `claude -p`
- A tiny MCP server with channel-specific tools (`send_message`, `speak`)
- Optional Python sidecars for Whisper + Kokoro

**Compared to [NanoClaw](https://github.com/qwibitai/nanoclaw):** NanoClaw is dramatically larger because it solves a different problem — multi-tenant isolation, per-session Docker containers, credential vaulting, an entity model for users → groups → sessions. marsClaw is single-user personal-scale; the simplicity matches the scope. For a full feature-by-feature breakdown, see [docs/vs-nanoclaw.md](docs/vs-nanoclaw.md).

**Upside of being a thin wrapper:** when Anthropic or Google ship a new model, better tool use, or improved compaction, we get it for free — no code changes, just `npm i -g @anthropic-ai/claude-code@latest`.

**Tradeoff to be honest about:** we're coupled to the shape of two specific CLI binaries. If `-p` changes or stdout format shifts, we break. And subprocess-per-message has a ~1-3s cold-start that a long-running agent process wouldn't. For a personal chat agent that's fine. For a high-throughput system it wouldn't be.

## Voice (optional)

WhatsApp voice notes get transcribed; the agent can reply in synthesized speech. Both directions run locally.

### Install

```bash
# One-time prereqs
brew install python@3.11 ffmpeg          # macOS
# or: sudo apt install python3 python3-venv ffmpeg

# Create venv, install faster-whisper + kokoro-onnx, download models (~650MB total)
bun run voice install
```

Setup will offer to do all of this automatically if you say `y` to *"Enable voice transcription?"*.

### Run

```bash
bun run voice start          # starts both sidecars (detached, PIDs in data/voice-*.pid)
bun run voice status         # whisper: ok · kokoro: ok
echo 'MARSCLAW_VOICE=1' >> .env
bun run start                # restart the bot
```

Send a voice note from WhatsApp. You should see:

```
[whatsapp] in  …@lid: [Voice]: hi how's the weather
[claude] start  whatsapp:…@lid
[claude] end    whatsapp:…@lid  4.8s  0 chars
[whatsapp] out (voice, 18.4KB) …@lid: It's sunny and 24…
```

### How it works

- **In:** the WhatsApp adapter detects `audioMessage`, downloads the ogg/opus blob, POSTs to `http://127.0.0.1:9000/transcribe`, and prepends `[Voice]: <transcript>` to whatever text the user also typed. From the agent's perspective it's just text.
- **Out:** the agent calls the `speak({ text })` MCP tool. The tool POSTs to `http://127.0.0.1:9001/v1/audio/speech` (Kokoro is OpenAI-compatible) and writes the returned ogg/opus to `data/voice-out/<id>.ogg`. An `outbox` row with `audio_path` set goes onto the queue; the channel adapter sends it as a proper WhatsApp voice note (`ptt: true`).
- Agent persona files (`GEMINI.md` / `CLAUDE.md`) tell the agent to call `speak` whenever the user's message starts with `[Voice]:` and to default to voice-only replies in that case.

### Voices

The default voice is `af_heart`. Override globally with `KOKORO_VOICE=…` in `.env`, or per-call by passing `voice` to the `speak` tool. Built-in voices include `af_heart`, `af_bella`, `af_nicole`, `am_adam`, `am_michael`, `bf_emma`, `bm_george`.

### Model sizes

Whisper defaults to `base` (~150MB, good for English + accents). Override with `WHISPER_MODEL=small` for better accuracy or `tiny` for faster transcription on slow hardware. Re-run `bun run voice install` after changing.

## Configuration (`.env`)

`setup` writes this for you; edit by hand to tweak.

| Key | Required | Notes |
|---|---|---|
| `AGENT_PROVIDER` | yes | `gemini` or `claude` |
| `TELEGRAM_BOT_TOKEN` | per-channel | From [@BotFather](https://t.me/BotFather) |
| `SLACK_BOT_TOKEN` | per-channel | `xoxb-…` |
| `SLACK_APP_TOKEN` | per-channel | `xapp-…` (needs `connections:write`) |
| `MARSCLAW_WHATSAPP` | per-channel | Set to `1`; auth via QR (scanned during setup, or on first start) |
| `MARSCLAW_VOICE` | per-feature | Set to `1` to enable Whisper STT + Kokoro TTS (sidecars must be running) |
| `WHISPER_URL` | optional | Whisper sidecar URL (default `http://127.0.0.1:9000`) |
| `WHISPER_MODEL` | optional | `tiny` / `base` / `small` / `medium` / `large` (default `base`) |
| `KOKORO_URL` | optional | Kokoro sidecar URL (default `http://127.0.0.1:9001`) |
| `KOKORO_VOICE` | optional | Default voice (`af_heart`, `af_bella`, `am_adam`, …) |
| `KOKORO_FORMAT` | optional | `ogg` (proper voice note) / `mp3` / `wav` |
| `GEMINI_API_KEY` | optional | Use a paid key instead of OAuth (higher quota) |
| `MARSCLAW_TIMEZONE` | optional | IANA tz (e.g. `Asia/Colombo`) — the agent's "now". Prompted at setup; default `UTC` |
| `MARSCLAW_LOCATION` | optional | Free-text location for personalization (e.g. `Colombo, Sri Lanka`) |
| `MARSCLAW_AGENT_TIMEOUT_MS` | optional | Per-message timeout (default `120000`) |
| `MARSCLAW_WHATSAPP_VERBOSE` | optional | Set to `1` to dump Baileys protocol logs |

## Memory and skills

- `GEMINI.md` / `CLAUDE.md` — agent persona, behavior, tools. Edit either or both.
- `skills/*.md` — sub-instructions referenced via `@skills/<name>.md` from the persona file.
- `MEMORY.md` — the agent's own long-term memory. Local-only, **gitignored**. Seeded from `MEMORY.template.md` on first run.

To reset memory: `rm MEMORY.md && bun run start`.

## Privacy — what's gitignored

These never leave your machine:

- `.env` — all credentials (channel tokens, API keys)
- `data/` — SQLite db, WhatsApp linked-device auth, downloaded message media
- `MEMORY.md` — anything the agent has noted about you (people, preferences, projects)

The agent CLI's own credentials live in your home directory (`~/.gemini/`, `~/.claude.json`), not in this repo.

## Provider notes

**Gemini CLI** with OAuth (free tier): daily quota resets ~16–24h. When exhausted, the bot replies with a friendly note instead of going silent. Bypass with `GEMINI_API_KEY=…` or `bun run provider claude`.

**Claude Code**: invoked with `--dangerously-skip-permissions` because there's no human in the loop to approve tool calls.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| WhatsApp keeps cycling (`code=405/428`) | Outdated Baileys protocol | `bun update baileys` |
| Connected but no replies | Replaying history (`type: append`) — only `notify` is processed | Wait a few seconds, then send a fresh message |
| `[gemini] timeout after 120000ms` | Slow tool loop or quota retries | Bump `MARSCLAW_AGENT_TIMEOUT_MS` or switch provider |
| `[whatsapp] skipped non-text (audioMessage)` | Voice support disabled | `bun run voice start` and set `MARSCLAW_VOICE=1` |
| `[whatsapp] transcribe failed` | Whisper sidecar down or unhealthy | `bun run voice status`; restart with `bun run voice restart` |
| `Speech synthesis failed: … kokoro sidecar` | Kokoro sidecar not running | `bun run voice start` |
| `[whatsapp] giving up after 5 failed connection attempts` | Too many linked devices, or geo block | Unlink from phone, or try a different network |
| Same reply sent 2-3 times | Was a drain-race bug — fixed in `src/index.ts` | Pull latest; restart |

For deeper debugging, set `MARSCLAW_WHATSAPP_VERBOSE=1` to see Baileys protocol logs.

## License

MIT.
