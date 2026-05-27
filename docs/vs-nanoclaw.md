# marsClaw vs NanoClaw — thorough comparison

Both projects build personal-chat agents on top of large language models. They make very different tradeoffs. This doc walks the axes one at a time so you can pick the right one for the situation.

[NanoClaw](https://github.com/qwibitai/nanoclaw) is the upstream multi-tenant agent platform. marsClaw is a stripped-down personal-scale rewrite that delegates the agent loop to off-the-shelf CLIs (Gemini CLI or Claude Code).

## At-a-glance

| | marsClaw | NanoClaw |
|---|---|---|
| Code size | ~1500 lines of TS | dramatically larger (host + container-runner + skills + tests) |
| Target user | one person on their laptop | one host serving many people, multi-tenant |
| Isolation | none — agent runs as the host user | per-session Docker / Apple Container |
| Agent runtime | Gemini CLI **or** Claude Code CLI (subprocess) | Claude Agent SDK in-container; OpenCode via providers branch |
| State store | one SQLite file | central DB + per-session inbound.db + outbound.db |
| Credentials | `.env` | OneCLI credential vault with approval flows |
| Setup | one interactive `setup.sh`, ~2 min | multi-step (OneCLI, container build, mounts, service install) |
| Channels shipped | Telegram, Slack, WhatsApp baked in | ~15 adapters, installed via `/add-<name>` skills |
| Self-modification | none | `install_packages`, `add_mcp_server` (admin-approved) |
| Provider switch | `bun run provider <name>` — 1 command | per-group `agent_provider` field; lives in central DB |

---

## Architecture

| | Pros | Cons |
|---|---|---|
| **marsClaw** — single Bun process, subprocess per message | Trivial to debug; one process to inspect; no IPC; cold-start ~1-3s; no Docker | One crash kills everything; agent has full host fs access; no per-conversation isolation |
| **NanoClaw** — host orchestrates per-session containers; two SQLite DBs per session as the only IO surface | Strong fault isolation (container crash ≠ host crash); concurrent sessions don't interfere; cross-mount DB pattern is well-tested | Two-DB design is genuinely tricky (the `journal_mode=DELETE` invariant, the seq parity rule, the heartbeat file); container build cache staleness is real; debugging a stuck session means correlating files across mounts |

## Isolation & security

| | Pros | Cons |
|---|---|---|
| **marsClaw** | Nothing to configure; agent inherits user perms which matches "personal bot" intent | Hallucinating or malicious agent can read/write/delete anything in your home directory; tokens sit in `.env` on disk; no audit log of what the agent did |
| **NanoClaw** | Containerized agent; OneCLI mediates all credentialed calls (secrets never enter the agent's context); approval flows route to scoped admins → global admins → owners | OneCLI adds a long-poll loop you have to keep alive; "selective" secret mode default catches every new operator; cross-container session sharing requires extra care |

## Entity model & multi-user

| | Pros | Cons |
|---|---|---|
| **marsClaw** | `(channel_prefix:thread_id)` is the entire identity model — 0 abstractions to learn | Anyone with your bot's chat handle can talk to your bot; no way to scope what they can do; no "admin" concept |
| **NanoClaw** | Real users with roles (owner / admin scoped or global); per-agent-group membership; three isolation levels (agent-shared, shared, separate agents); cold-DM resolution with `user_dms` cache | The wiring matrix (users × agent_groups × messaging_groups × sessions) is a real learning curve; for a single user it's pure overhead |

## Channels

| | Pros | Cons |
|---|---|---|
| **marsClaw** | Three adapters shipped, lazy-loaded so unused ones cost nothing; adding a channel = write a new file matching the `Channel` interface (~60 lines) | Only 3 channels right now; iMessage, Discord, Linear, GitHub etc. would all need rewriting |
| **NanoClaw** | 15+ channels including Discord, Teams, Linear, GitHub, iMessage (local + remote), Webex, Matrix, WeChat, DeltaChat, Emacs, X, Slack, Telegram, both WhatsApp variants | Each channel skill is a separate install step; the skills/branches model means channel code isn't on trunk — `git clone` doesn't get you the adapter you want |

## Voice (STT / TTS)

Conceptually identical architecture: HTTP sidecars for Whisper and Kokoro.

| | Pros | Cons |
|---|---|---|
| **marsClaw** | Python venv, no Docker; one `setup-voice.sh`; same OpenAI-compatible Kokoro endpoint shape as nanoclaw-voice | Two Python services to babysit; ffmpeg + Python 3.10+ prereqs; ~650MB models on disk |
| **NanoClaw (nanoclaw-voice)** | `docker compose up -d` and you're done; sidecars auto-restart with the rest of the stack | Requires Docker; first-time image pull is slow; can't run in environments where Docker is blocked |

## Tools available to the agent

| | Pros | Cons |
|---|---|---|
| **marsClaw** | Whatever the chosen CLI ships (shell, read, write, edit, glob, grep, web fetch, web search) + our `send_message` and `speak` MCP tools — we wrote ~120 lines of tool code total | Bound by what Gemini CLI / Claude Code expose; no rich tool ecosystem of our own; no sub-agent spawning, no scheduling, no built-in image gen / LaTeX / etc. |
| **NanoClaw** | Rich custom MCP suite: `send_message`, `send_file`, `edit_message`, `schedule_task`, `ask_user_question`, `install_packages`, `add_mcp_server`, sub-`agents` spawn, `voice`, `latex`, `imagegen`, `interactive` | More to maintain; tool bugs are yours to fix; each tool's deps go into the container image |

## Memory & skills

| | Pros | Cons |
|---|---|---|
| **marsClaw** | One persona file (`GEMINI.md` + `CLAUDE.md`, identical content), one `MEMORY.md` the agent edits, `skills/*.md` referenced via `@skills/...` — sum total of context engineering = ~5 files | No per-conversation persona variants; no automatic transcript archiving; if MEMORY.md grows huge it has to be manually split |
| **NanoClaw** | Per-agent-group `CLAUDE.md` + `CLAUDE.local.md`; agent owns a workspace and a `conversations/` archive (auto-created by PreCompact hook); skill ecosystem with 4 distinct skill types | Lots of context files to keep in sync; "where does this instruction live" is a real question |

## Self-modification

| | Pros | Cons |
|---|---|---|
| **marsClaw** | None — restart loop is trivial because there's nothing to mutate | Want a new tool? Stop the bot, write code, restart. Can't say "agent, install pandas" |
| **NanoClaw** | `install_packages` (apt/npm) and `add_mcp_server` work end-to-end with admin approval, image rebuild, container restart; planned source-edit draft/activate flow | Significant infrastructure (approval primitives, image rebuild logic, restart orchestration); approval delivery has many subtle paths |

## Setup & onboarding

| | Pros | Cons |
|---|---|---|
| **marsClaw** | `bash setup.sh` → interactive — provider, login, channels, voice, all in one flow; auto-detected login state; clones to working bot in ~2 min | Limited scope — no service installer, no upgrade migration tool, no per-machine config layers |
| **NanoClaw** | Setup walks operator through host install, OneCLI vault, container image build, mount allowlist, service installation (launchd/systemd), first-agent bootstrap; migration script for v1 → v2 | Lots of steps; lots of places it can wedge; full setup feels heavy if you just want to chat with a bot |

## Observability

| | Pros | Cons |
|---|---|---|
| **marsClaw** | One terminal, one log stream, `bun run status` for db summary; per-message timing logs (`[gemini] start/end`) baked in | If you `Ctrl+C` and lose the terminal, no persistent log file; sidecar logs are separate |
| **NanoClaw** | Structured logs: `nanoclaw.log`, `nanoclaw.error.log`, `setup-steps/*.log`; session DBs as inspectable forensic artifacts; container heartbeat, pending_questions, processing_ack tables | Container logs are ephemeral (`--rm` flag) — silent failures inside the container leave nothing behind; correlating an issue across host + container is multi-step |

## Performance

| | Pros | Cons |
|---|---|---|
| **marsClaw** | No idle containers eating RAM; cold start ~1-3s acceptable for sparse personal-chat patterns | Cold start *every* message; if you send 50 fast messages the agent loop pays 50× startup |
| **NanoClaw** | Sessions stay warm between turns; idle containers killed by sweep; fast on burst usage; gentle on the rate limiter | First message of a new session is slow (container boot); more memory at idle if you have many active sessions |

## Provider portability

| | Pros | Cons |
|---|---|---|
| **marsClaw** | 30 lines of code per new provider (`{ bin, npmPackage, buildArgs, isAuthed }`); two ship by default; runtime switch with `bun run provider` | Bound to whatever non-interactive prompt mode each CLI exposes; if `-p` changes shape we break |
| **NanoClaw** | Provider abstraction in `container/agent-runner/src/providers/`; per-agent-group provider; richer event translation between SDK events and host loop | Adding a new provider means understanding the full event protocol (init, result, retry, rate_limit, compact_boundary, task_notification, etc.) |

## Failure modes seen in practice

| Failure | marsClaw | NanoClaw |
|---|---|---|
| Gemini quota exhausted | Friendly reply + log; switch with `bun run provider claude` | Per-agent-group provider; quota is in OneCLI's domain |
| WhatsApp Baileys protocol drift | Bump `baileys` version in `package.json`, restart | Same Baileys, but inside container — need to rebuild image |
| Agent process hangs mid-message | 120s timeout in `agent.ts`, SIGTERM; visible in logs | 60s sweep loop detects stuck container; declared-timeout hooks adjust tolerance |
| Two messages to same thread arrive at once | `inFlight` map serializes per-thread | Same idea, but at session-DB level (one writer per file) |
| Outbox drain races and duplicate-sends | Fixed with `draining` boolean guard | Two-DB design means host and container can't race because each owns its file |

---

## When to pick which

**Pick marsClaw if:**

- It's just you, on your machine, talking to your own bot
- You'd rather read the entire codebase in one sitting than learn a domain model
- Docker isn't available or wanted (locked-down work laptop, restricted environment)
- You want to swap between Gemini and Claude without touching code
- You're learning what a personal-chat-agent architecture looks like before committing
- You believe in delegating the hard parts (agent loop, tool plumbing) to Anthropic / Google

**Pick NanoClaw if:**

- More than one person uses the bot
- You need per-user / per-group workspace isolation
- You need approval workflows around credentialed actions
- You want agents to install their own deps / extend themselves at runtime
- You want 15+ channel adapters available without coding
- You're deploying somewhere shared, not a personal laptop
- You're willing to invest in learning a richer model in exchange for production-grade primitives

---

## The honest summary

They're not really competitors. NanoClaw is a multi-tenant agent platform; marsClaw is a personal-scale wrapper that delegates the hard work to off-the-shelf CLIs.

marsClaw is what NanoClaw would look like with all the multi-user complexity surgically removed and the agent runtime swapped from "in-process SDK" to "subprocess CLI". You'd use NanoClaw for a team or a product. You'd use marsClaw because it's Friday night and you want a Telegram bot that can speak by Sunday.
