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
  allowed_jids: string[];
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
}

function defaults(): MarsclawConfig {
  return {
    bot_name: 'Mars',
    owner_name: '',
    owner_phone: '',
    whatsapp_pair_owner: false,
    whatsapp_pair_code: '',
    allowed_jids: [],
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
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<MarsclawConfig>;
      Object.assign(cfg, parsed);
    } catch (err) {
      log.warn('Failed to parse config.json — using defaults', { err, path: CONFIG_PATH });
    }
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
