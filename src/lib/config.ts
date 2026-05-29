// Runtime configuration. Read once at boot, frozen.
//
// Precedence (lowest → highest):
//   1. defaults (this file)
//   2. data/config.json (non-secret runtime config)
//   3. process.env via the MARSCLAW_* convention
//
// Env wins because existing users have `.env` muscle-memory and the upgrade
// must not silently change behaviour. Secrets (API tokens) stay in .env;
// data/config.json is committed to gitignore but is not where tokens live.

import { existsSync, readFileSync } from 'node:fs';
import { writeAtomic } from './atomic.ts';
import { log } from './log.ts';

export const CONFIG_PATH = process.env.MARSCLAW_CONFIG ?? 'data/config.json';

export interface MarsclawConfig {
  bot_name: string;
  // What the assistant calls its human (the operator). Injected into the
  // chat persona and seeded into MEMORY.md at setup.
  owner_name: string;
  // The operator's WhatsApp number, digits only (country code + number, no +).
  // Used for the allow-list and as identity context.
  owner_phone: string;
  // One-shot pairing flag. While true, an inbound WhatsApp DM whose text
  // matches whatsapp_pair_code has its real JID captured into allowed_jids
  // (handles WhatsApp's opaque @lid that a phone-derived JID can't match),
  // then this flips false. See whatsapp.ts.
  whatsapp_pair_owner: boolean;
  // The code the owner must send as a WhatsApp message to complete pairing.
  // Cleared once paired. Only meaningful while whatsapp_pair_owner is true.
  whatsapp_pair_code: string;
  // Epoch-ms after which the pair window expires even if no one has sent the
  // code. 0 means "no expiry" (legacy / disabled). Set to Date.now()+5min by
  // setup so a paired-but-not-yet-completed session can't stay open forever.
  whatsapp_pair_expires_at: number;
  allowed_jids: string[];
  // Telegram chat ids allowed to message the bot. Non-empty = enforce (reject
  // anyone not listed). Empty = accept all, logging each new sender's chat id
  // so you can lock it down. Telegram has no phone-based identity, so this is
  // the channel's only sender gate.
  allowed_telegram_chats: string[];
  // Slack user ids allowed to message the bot. Same semantics as
  // allowed_telegram_chats (empty = accept all, with a per-user warning).
  allowed_slack_users: string[];
  allowed_paths: string[];
  max_sessions: number;
  idle_ms: number;
  // Hard ceiling on session lifetime regardless of activity. Bounds slow
  // leaks in the SDK subprocess / MCP child / third-party deps that idle
  // teardown alone can't catch on a chatty thread. 0 disables.
  max_session_age_ms: number;
  // IANA timezone (e.g. "Asia/Colombo"). Injected into every agent turn so the
  // assistant knows the user's *current* local time. Defaults to UTC.
  timezone: string;
  // Free-text location (e.g. "Colombo, Sri Lanka"). Personalization context the
  // agent can't infer on its own; surfaced alongside the time each turn.
  location: string;
  voice_enabled: boolean;
  agent_provider: 'claude' | 'gemini';
  extra_bash_denylist: string[];
  // Inbound rate-limit per sender (both bands must clear). 0 disables.
  rate_limit_per_minute: number;
  rate_limit_per_hour: number;
  // Anthropic spend cap. The agent refuses to run new turns once today's
  // spend (USD, summed from SDKResultSuccess.total_cost_usd) crosses this.
  daily_usd_budget: number;
  // When false (default), MCP tools that take outbound or mutating actions
  // (gmail_send, sheets_write, calendar_create_event, and write-style *_raw
  // calls) refuse to run. The agent reads untrusted content (email, web), so
  // acting as the owner is opt-in. Set true to allow them. See lib/mutation-gate.ts.
  // Ignored when mutation_approval is 'all' (per-call approval supersedes it).
  allow_mutating_tools: boolean;
  // Per-call operator approval for mutating tools.
  //   'off' (default) → use the allow_mutating_tools flag (all-or-nothing).
  //   'all'           → every mutating tool requires an out-of-band approval:
  //                     the broker sends a structured prompt + nonce to the
  //                     operator's chat, the tool blocks until the operator
  //                     replies the nonce (intercepted before the agent sees
  //                     it). See lib/approval-gate.ts.
  mutation_approval: 'off' | 'all';
  // When false (default), the chat agent has NO shell: the Bash tool is removed
  // entirely (and denied as a backstop). A denylist can't make shell safe —
  // `cat .e''nv`, `python -c`, `base64`, `security find-generic-password` all
  // bypass any pattern set — so the only sound posture is to remove the
  // capability. Enabling shell reopens credential/file exfiltration whenever
  // the agent processes untrusted content. (Claude provider only; Gemini has
  // no tools.)
  allow_shell: boolean;
  // When false (default), WebFetch/WebSearch are removed. With the agent
  // reading untrusted email/web, an open fetch is an exfiltration channel
  // (secrets encoded into a URL the agent retrieves). Enable to trade that
  // egress risk for web access.
  allow_web: boolean;
  // Host allow-list for WebFetch when allow_web is true. Each entry matches
  // exact host OR any subdomain ("wikipedia.org" covers en.wikipedia.org;
  // "*.gov" covers every .gov sub). Empty list + allow_web=true means
  // WebSearch works (search backend only) but no WebFetch will succeed —
  // safe default. See lib/url-allowlist.ts.
  //
  // When egress_mode is 'gateway' AND egress is actually enforced (the launch
  // wrapper sets MARSCLAW_EGRESS_ENFORCED=1 after establishing a netns on Linux
  // or a verified pf anchor on macOS), this allow-list is bypassed for WebFetch
  // — the SSRF-protected gateway becomes the boundary instead. Without enforced
  // egress the allow-list stays the boundary (fail-safe). See tools/egress-gateway/.
  allowed_web_domains: string[];
  // Network egress posture.
  //   'off' (default) → no gateway; allowed_web_domains is the WebFetch boundary.
  //   'gateway'       → all outbound is meant to traverse the local egress
  //                     gateway. Only relaxes the allow-list when enforcement is
  //                     confirmed via MARSCLAW_EGRESS_ENFORCED (set by the launch
  //                     wrapper). On macOS that means the pf anchor is loaded.
  egress_mode: 'off' | 'gateway';
}

function defaults(): MarsclawConfig {
  return {
    bot_name: 'Mars',
    owner_name: '',
    owner_phone: '',
    whatsapp_pair_owner: false,
    whatsapp_pair_code: '',
    whatsapp_pair_expires_at: 0,
    allowed_jids: [],
    allowed_telegram_chats: [],
    allowed_slack_users: [],
    allowed_paths: [process.cwd()],
    max_sessions: 20,
    idle_ms: 15 * 60_000,
    max_session_age_ms: 4 * 60 * 60_000,
    timezone: 'UTC',
    location: '',
    voice_enabled: false,
    agent_provider: 'gemini',
    extra_bash_denylist: [],
    rate_limit_per_minute: 10,
    rate_limit_per_hour: 60,
    // 0 = disabled. Only meaningful when running on a metered API key
    // (ANTHROPIC_API_KEY); under a Claude Pro/Max subscription via OAuth,
    // total_cost_usd is informational only — no per-token billing — so the
    // budget check is auto-skipped regardless of this value.
    daily_usd_budget: 0,
    allow_mutating_tools: false,
    mutation_approval: 'off',
    allow_shell: false,
    allow_web: false,
    allowed_web_domains: [],
    egress_mode: 'off',
  };
}

function parseList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function parseInt10(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

let cached: MarsclawConfig | null = null;

export function loadConfig(): MarsclawConfig {
  if (cached) return cached;

  const cfg = defaults();

  // Overlay config.json if present.
  //
  // Security: a corrupted config.json must NOT silently fall back to defaults.
  // Defaults open the channel allow-lists (`allowed_telegram_chats: []` /
  // `allowed_slack_users: []` mean "accept all"), so a paranoid lock-down can
  // be silently undone by a torn write or a manual edit error. We fail loud:
  // if the file exists but is unparseable, throw and refuse to start. The
  // operator must either fix the file or delete it explicitly.
  if (existsSync(CONFIG_PATH)) {
    let raw: string;
    try {
      raw = readFileSync(CONFIG_PATH, 'utf-8');
    } catch (err) {
      throw new Error(
        `Cannot read ${CONFIG_PATH}: ${(err as Error)?.message ?? String(err)}. ` +
          `Fix permissions or delete the file to use defaults; the bot refuses to ` +
          `start with an unreadable config to avoid silently opening allow-lists.`,
      );
    }
    let parsed: Partial<MarsclawConfig>;
    try {
      parsed = JSON.parse(raw) as Partial<MarsclawConfig>;
    } catch (err) {
      throw new Error(
        `Refusing to start: ${CONFIG_PATH} is not valid JSON (${
          (err as Error)?.message ?? String(err)
        }). Fix the file or delete it to use defaults — the bot will not silently ` +
          `fall back to defaults because defaults open the channel allow-lists.`,
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `Refusing to start: ${CONFIG_PATH} must be a JSON object, got ${
          Array.isArray(parsed) ? 'array' : typeof parsed
        }.`,
      );
    }
    Object.assign(cfg, parsed);
  }

  // Env overrides (highest precedence).
  const envBotName = process.env.MARSCLAW_BOT_NAME;
  if (envBotName) cfg.bot_name = envBotName;

  const envOwnerName = process.env.MARSCLAW_OWNER_NAME;
  if (envOwnerName) cfg.owner_name = envOwnerName;

  const envOwnerPhone = process.env.MARSCLAW_OWNER_PHONE;
  if (envOwnerPhone) cfg.owner_phone = envOwnerPhone.replace(/\D/g, '');

  const envJids = parseList(process.env.MARSCLAW_WHATSAPP_ALLOWED_JIDS);
  if (envJids !== undefined) cfg.allowed_jids = envJids;

  const envTgChats = parseList(process.env.MARSCLAW_TELEGRAM_ALLOWED_CHATS);
  if (envTgChats !== undefined) cfg.allowed_telegram_chats = envTgChats;

  const envSlackUsers = parseList(process.env.MARSCLAW_SLACK_ALLOWED_USERS);
  if (envSlackUsers !== undefined) cfg.allowed_slack_users = envSlackUsers;

  const envPaths = parseList(process.env.MARSCLAW_ALLOWED_PATHS);
  if (envPaths !== undefined) cfg.allowed_paths = envPaths;

  const envMax = parseInt10(process.env.MARSCLAW_MAX_SESSIONS);
  if (envMax !== undefined) cfg.max_sessions = envMax;

  const envIdle = parseInt10(process.env.MARSCLAW_CLAUDE_IDLE_MS);
  if (envIdle !== undefined) cfg.idle_ms = envIdle;

  const envMaxAge = parseInt10(process.env.MARSCLAW_CLAUDE_MAX_SESSION_AGE_MS);
  if (envMaxAge !== undefined) cfg.max_session_age_ms = envMaxAge;

  const envTz = process.env.MARSCLAW_TIMEZONE;
  if (envTz) cfg.timezone = envTz;

  const envLocation = process.env.MARSCLAW_LOCATION;
  if (envLocation) cfg.location = envLocation;

  const envVoice = parseBool(process.env.MARSCLAW_VOICE);
  if (envVoice !== undefined) cfg.voice_enabled = envVoice;

  const envProvider = process.env.AGENT_PROVIDER;
  if (envProvider === 'claude' || envProvider === 'gemini') cfg.agent_provider = envProvider;

  const envRateMin = parseInt10(process.env.MARSCLAW_RATE_LIMIT_PER_MINUTE);
  if (envRateMin !== undefined) cfg.rate_limit_per_minute = envRateMin;
  const envRateHr = parseInt10(process.env.MARSCLAW_RATE_LIMIT_PER_HOUR);
  if (envRateHr !== undefined) cfg.rate_limit_per_hour = envRateHr;
  const envBudget = process.env.MARSCLAW_DAILY_USD_BUDGET;
  if (envBudget) {
    const n = Number.parseFloat(envBudget);
    if (Number.isFinite(n) && n >= 0) cfg.daily_usd_budget = n;
  }

  const envAllowMut = parseBool(process.env.MARSCLAW_ALLOW_MUTATING_TOOLS);
  if (envAllowMut !== undefined) cfg.allow_mutating_tools = envAllowMut;

  const envMutApproval = process.env.MARSCLAW_MUTATION_APPROVAL;
  if (envMutApproval === 'off' || envMutApproval === 'all') cfg.mutation_approval = envMutApproval;

  const envAllowShell = parseBool(process.env.MARSCLAW_ALLOW_SHELL);
  if (envAllowShell !== undefined) cfg.allow_shell = envAllowShell;

  const envAllowWeb = parseBool(process.env.MARSCLAW_ALLOW_WEB);
  if (envAllowWeb !== undefined) cfg.allow_web = envAllowWeb;

  const envWebDomains = parseList(process.env.MARSCLAW_ALLOWED_WEB_DOMAINS);
  if (envWebDomains !== undefined) cfg.allowed_web_domains = envWebDomains;

  const envEgress = process.env.MARSCLAW_EGRESS_MODE;
  if (envEgress === 'off' || envEgress === 'gateway') cfg.egress_mode = envEgress;

  cached = Object.freeze(cfg);
  return cached;
}

// For tests — clears the memoized config so the next loadConfig() re-reads.
export function _resetConfigCacheForTests(): void {
  cached = null;
}

export function writeConfig(partial: Partial<MarsclawConfig>): MarsclawConfig {
  let current: Partial<MarsclawConfig> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      current = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Partial<MarsclawConfig>;
    } catch (err) {
      log.warn('Overwriting unparseable config.json', { err, path: CONFIG_PATH });
    }
  }
  const merged = { ...current, ...partial };
  writeAtomic(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n');
  cached = null;
  return loadConfig();
}
