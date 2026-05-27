---
slug: /
title: Overview
sidebar_position: 1
---

# marsClaw docs

Pick by what you need to do.

## Get started

→ [../README.md](https://github.com/deBilla/marsclaw/blob/main/README.md) for the elevator pitch and quick-start. Everything else here is reference.

## Understand the system

- [architecture.md](architecture.md) — message flow, components, SQLite schema, per-thread serialization, what the agent SDK delegates vs. what we own.
- [vs-nanoclaw.md](vs-nanoclaw.md) — when to pick marsClaw vs the multi-tenant cousin.

## Configure it

- [configuration.md](configuration.md) — full `.env` and `data/config.json` reference; precedence rules; `allowed_paths` and Bash denylist.
- [channels.md](channels.md) — per-channel setup (Telegram, Slack, WhatsApp) including the WhatsApp pairing flow.
- [providers.md](providers.md) — Gemini vs Claude, switching, auth, costs, failover.
- [voice.md](voice.md) — Whisper STT + Kokoro TTS sidecars, voices, model sizes.
- [google.md](google.md) — Google OAuth, multiple accounts, Gmail/Calendar/Drive/Sheets/Docs/Slides MCP tools.

## Run it

- [operations.md](operations.md) — launchd service, backups, observability, troubleshooting cheatsheet.

## Hack on it

- [development.md](development.md) — codebase tour, tests, adding a channel / MCP tool / provider, migrations.
