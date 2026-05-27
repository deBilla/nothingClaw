# Voice

WhatsApp voice notes get transcribed; the agent can reply in synthesized speech. Both directions run locally — no cloud, no Docker.

## Stack

Two Python sidecars on localhost:

| Sidecar  | Engine                            | Port  | Endpoint                          |
|---|---|---|---|
| Whisper  | `faster-whisper`                  | 9000  | `POST /transcribe`                |
| Kokoro   | `kokoro-onnx` (OpenAI-compatible) | 9001  | `POST /v1/audio/speech`           |

Source: [tools/whisper-server.py](https://github.com/deBilla/marsclaw/blob/main/tools/whisper-server.py), [tools/kokoro-server.py](https://github.com/deBilla/marsclaw/blob/main/tools/kokoro-server.py). Both share one venv under `tools/voice-env/`.

## Install

```bash
brew install python@3.11 ffmpeg          # macOS
# or: sudo apt install python3 python3-venv ffmpeg

bun run voice install                    # creates venv, installs sidecars, downloads ~650MB of models
```

Setup will offer to do this automatically if you answer `y` to *"Enable voice transcription?"*.

## Run

```bash
bun run voice start         # detached; PIDs in data/voice-*.pid
bun run voice status        # whisper: ok · kokoro: ok
bun run voice stop
```

Then enable it for the bot:

```env
MARSCLAW_VOICE=1
```

…or set `voice_enabled: true` in `data/config.json`. Restart the bot.

## Sending a voice note

From WhatsApp, send a voice message. You should see:

```
[whatsapp] in  …@lid: [Voice]: hi how's the weather
[claude] start  whatsapp:…@lid
[claude] end    whatsapp:…@lid  4.8s  0 chars
[whatsapp] out (voice, 18.4KB) …@lid: It's sunny and 24…
```

## How it works

### Inbound (STT)

1. The WhatsApp adapter detects `audioMessage` (ogg/opus blob, ~16kHz).
2. Downloads the blob, POSTs to `http://127.0.0.1:9000/transcribe`.
3. Prepends `[Voice]: <transcript>` to any accompanying text caption.
4. From the agent's perspective it's just text.

### Outbound (TTS)

1. The agent calls the `speak({ text, voice? })` MCP tool. ([src/mcp/speak.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/speak.ts))
2. The tool POSTs to `http://127.0.0.1:9001/v1/audio/speech` (OpenAI-shaped) with the configured voice.
3. Writes the returned ogg/opus to `data/voice-out/<id>.ogg`.
4. Inserts an `outbox` row with `audio_path` set.
5. The drain loop calls `router.send(threadId, text, { audioPath })`; WhatsApp sends it as a proper voice note (`ptt: true`). On channels without audio support the text is sent instead as fallback.

The persona files ([GEMINI.md](https://github.com/deBilla/marsclaw/blob/main/GEMINI.md), [CLAUDE.md](https://github.com/deBilla/marsclaw/blob/main/CLAUDE.md)) tell the agent to call `speak` whenever the user's message starts with `[Voice]:`, default to voice-only replies in that case, and keep the speech short.

## Voices

The default voice is `af_heart`. Override globally in `.env`:

```env
KOKORO_VOICE=af_bella
```

Or per-call by passing `voice` to the `speak` tool. Built-in voices:

| Name        | Locale | Notes                |
|---|---|---|
| `af_heart`  | en-US  | Warm, default         |
| `af_bella`  | en-US  | Bright, expressive    |
| `af_nicole` | en-US  | Neutral newsreader    |
| `am_adam`   | en-US  | Male, conversational  |
| `am_michael`| en-US  | Male, deeper          |
| `bf_emma`   | en-GB  | British female        |
| `bm_george` | en-GB  | British male          |

## Audio format

```env
KOKORO_FORMAT=ogg   # default — sent as a true WhatsApp voice note
KOKORO_FORMAT=mp3   # sent as audio attachment
KOKORO_FORMAT=wav   # sent as audio attachment, larger files
```

Only `ogg/opus` renders as a proper voice-note bubble in WhatsApp. The other formats fall back to audio-file attachments.

## Model sizes

Whisper defaults to `base` (~150MB, good English + accents):

```env
WHISPER_MODEL=tiny     # ~75MB, fastest, less accurate
WHISPER_MODEL=base     # ~150MB (default)
WHISPER_MODEL=small    # ~500MB, better accuracy
WHISPER_MODEL=medium   # ~1.5GB
WHISPER_MODEL=large    # ~3GB
```

Re-run `bun run voice install` after changing — the new model needs to download.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `[whatsapp] skipped non-text (audioMessage)` | `MARSCLAW_VOICE` not set | `bun run voice start` and `MARSCLAW_VOICE=1` |
| `[whatsapp] transcribe failed` | Whisper sidecar down or unhealthy | `bun run voice status`; restart |
| `Speech synthesis failed: … kokoro sidecar` | Kokoro sidecar down | `bun run voice start` |
| Voice replies arriving as plain text | `KOKORO_FORMAT` is not `ogg`, or audio file outside `allowed_paths` | Set `KOKORO_FORMAT=ogg` |
| First voice request is slow (~5s) | Model lazy-load on the sidecar | Subsequent calls are fast; ignore |
