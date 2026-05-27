# Channels

marsClaw ships three messaging channels: Telegram, Slack, and WhatsApp. Each is optional; enable any combination. Adapters live in [src/channels/](https://github.com/deBilla/marsclaw/blob/main/src/channels/) and implement the `Channel` interface in [src/channels/types.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/types.ts).

```ts
interface Channel {
  send(threadId: string, text: string, opts?: SendOpts): Promise<void>;
  setTyping?(threadId: string): Promise<void>;
}
```

Thread IDs are channel-prefixed (`telegram:`, `slack:`, `whatsapp:`); the [ChannelRouter](https://github.com/deBilla/marsclaw/blob/main/src/channels/router.ts) uses the prefix to dispatch outbound sends back to the right adapter.

## Telegram

The simplest channel to set up.

1. Talk to [@BotFather](https://t.me/BotFather), `/newbot`, follow the prompts. You'll get a token like `123456:ABC-DEF…`.
2. Put it in `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=123456:ABC-DEF…
   ```
3. Restart the bot. Message your bot from Telegram.

Telegram supports text in/out and the typing indicator. No images, no voice notes on this adapter — Telegram is the boring-and-reliable channel. Adapter: [src/channels/telegram.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/telegram.ts).

## Slack

Uses Socket Mode — no public webhook needed.

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps). Pick "From scratch".
2. **OAuth & Permissions** → bot token scopes: `chat:write`, `im:history`, `im:read`, `im:write`, `app_mentions:read`, `users:read`. Install to your workspace. Copy `xoxb-…` → `SLACK_BOT_TOKEN`.
3. **Basic Information** → App-Level Tokens → "Generate Token and Scopes" with scope `connections:write`. Copy `xapp-…` → `SLACK_APP_TOKEN`.
4. **Socket Mode** → enable.
5. **Event Subscriptions** → enable, subscribe to bot events: `message.im`, `app_mention`.
6. Restart the bot. DM the app from Slack.

Adapter: [src/channels/slack.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/slack.ts). Lazy-loaded — non-Slack users don't pay the `@slack/bolt` import cost.

## WhatsApp

The richest channel: text, images (vision), voice notes in and out, document attachments. Uses [Baileys](https://github.com/WhiskeySockets/Baileys) — WhatsApp's web-multi-device protocol — so no Business API account needed.

### First-time link

Setup will walk you through this; the bot can be started inside the setup flow so the QR appears live. Manual route:

```env
MARSCLAW_WHATSAPP=1
```

Then `bun run start` and scan the QR with your phone:
**WhatsApp → Settings → Linked devices → Link a device**

Auth is saved to `data/whatsapp-auth/` (gitignored). Subsequent boots reconnect silently.

### Owner pairing

WhatsApp's `@lid` identifiers can differ from the phone-derived `@s.whatsapp.net` JID, so on a fresh link the bot can't tell which incoming JID is "you". Setup writes a one-shot pairing code into `data/config.json`: send the printed code from your phone, the bot captures the real JID into `allowed_jids`, and the code is cleared.

### Allow-list

Set `allowed_jids` in `data/config.json` (or `MARSCLAW_WHATSAPP_ALLOWED_JIDS=…` in env) to restrict who can talk to the bot. Empty list = allow anyone. On boot the log will say which mode you're in:

```
[whatsapp] allow-list active count=2
```

```
[whatsapp] allow-list disabled — accepting from any sender
```

### Useful commands

```bash
bun run whatsapp status       # link state + cached media count
bun run whatsapp reset        # wipe auth → forces a new QR
bun run whatsapp clear-media  # purge data/whatsapp-media/
```

### Images

Inbound images are downloaded to `data/whatsapp-media/` and passed to the agent as `@<path>` so Claude/Gemini vision can read them. Caption text (if any) accompanies the image.

### Voice

If `MARSCLAW_VOICE=1` and the Whisper sidecar is running, inbound voice notes are transcribed and prepended with `[Voice]:` so the agent knows to reply via the `speak` MCP tool. See [voice.md](voice.md).

### Verbose protocol logs

```bash
MARSCLAW_WHATSAPP_VERBOSE=1 bun run start
```

Adapter: [src/channels/whatsapp.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/whatsapp.ts), pairing: [src/channels/whatsapp-link.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/whatsapp-link.ts).

## Adding a new channel

Roughly ~60 lines. The skeleton:

```ts
// src/channels/mychannel.ts
import type { Channel, ChannelInit } from './types.ts';

export function createMyChannel(opts: { token: string } & ChannelInit): Channel {
  // 1. connect to the upstream SDK
  // 2. on inbound message → opts.onMessage(`mychannel:${threadId}`, text)
  // 3. expose send(threadId, text, opts) — strip the `mychannel:` prefix
  return {
    async send(threadId, text, sendOpts) { /* ... */ },
    async setTyping(threadId) { /* optional */ },
  };
}
```

Then wire it up in [src/index.ts](https://github.com/deBilla/marsclaw/blob/main/src/index.ts) behind a feature flag and the prefix in [src/channels/router.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/router.ts) is automatic — the router routes by the prefix you used.

## Failure modes

| Symptom | Channel | Fix |
|---|---|---|
| Connected but no replies; `[whatsapp] in append` | WhatsApp | Replaying history (`type: append`); only `notify` is processed. Send a fresh message. |
| `code=405/428` cycling | WhatsApp | Outdated Baileys protocol. `bun update baileys` |
| `[whatsapp] giving up after 5 failed connection attempts` | WhatsApp | Too many linked devices, or geo block. Unlink from phone, or try another network. |
| `Same reply 2-3 times` | any | Was a drain-race bug. Pull latest; restart. |
| `[slack] missing scope` | Slack | Add the listed scope, reinstall app. |
| Telegram bot doesn't see DMs | Telegram | `/setprivacy` in BotFather to disable group-only privacy (irrelevant for DMs but a common red herring). |
