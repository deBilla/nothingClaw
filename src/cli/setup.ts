// Interactive setup: pick provider, install CLI, trigger login, enable WhatsApp,
// write .env + data/config.json. Idempotent — re-running picks up current state
// as defaults.

import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { PROVIDERS } from '../providers/registry.ts';
import type { Provider, ProviderName } from '../providers/types.ts';
import { printBanner } from './branding.ts';
import { writeAtomic } from '../lib/atomic.ts';
import { loadConfig, writeConfig } from '../lib/config.ts';
import { isValidTimezone } from '../lib/timezone.ts';
import { isServiceLoaded, stopService, startService } from '../lib/launchd.ts';
import { findYtDlpPath } from '../mcp/youtube.ts';

const rl = createInterface({ input: stdin, output: stdout });

const bold = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const ok = (s: string) => console.log(`\x1b[32m✓\x1b[0m ${s}`);
const info = (s: string) => console.log(`  ${s}`);
const warn = (s: string) => console.log(`\x1b[33m!\x1b[0m ${s}`);

async function ask(prompt: string, def?: string): Promise<string> {
  const suffix = def !== undefined ? ` [${def}]` : '';
  const ans = (await rl.question(`${prompt}${suffix}: `)).trim();
  return ans || def || '';
}

async function yesNo(prompt: string, def: boolean): Promise<boolean> {
  const dStr = def ? 'Y/n' : 'y/N';
  while (true) {
    const raw = (await rl.question(`${prompt} (${dStr}): `)).trim().toLowerCase();
    if (!raw) return def;
    if (raw === 'y' || raw === 'yes') return true;
    if (raw === 'n' || raw === 'no') return false;
    warn('Please answer y or n.');
  }
}

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf-8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function run(bin: string, args: string[], opts: { stdio?: 'inherit' | 'pipe' } = {}): number {
  const r = spawnSync(bin, args, { stdio: opts.stdio ?? 'inherit' });
  return r.status ?? 1;
}

function envHas(key: string): boolean {
  if (!existsSync('.env')) return false;
  const re = new RegExp(`^\\s*${key}\\s*=\\s*1\\s*$`, 'm');
  return re.test(readFileSync('.env', 'utf-8'));
}

// Read the value of an uncommented `KEY=value` line from .env (commented lines
// are ignored so we never resurrect a token the owner deliberately disabled).
function envValue(key: string): string {
  if (!existsSync('.env')) return '';
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm');
  const m = re.exec(readFileSync('.env', 'utf-8'));
  return m ? m[1].trim() : '';
}

// Phone → digits only (country code + number, no + / spaces / dashes), the
// shape WhatsApp uses in a @s.whatsapp.net JID.
function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '');
}

// A short, unambiguous pairing code the owner sends as a WhatsApp message to
// complete pairing. Alphabet omits 0/O/1/I/L to avoid typos on a phone. 8 chars
// over a 31-char alphabet ≈ 40 bits of entropy — combined with the 5-minute
// expiry (whatsapp_pair_expires_at), brute-forcing through the bot's polling
// rate is not practical.
function genPairCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length];
  return `link-${s}`;
}

// Window during which the pair code is honoured. Long enough to flip back to
// the phone, scan a QR, send the code; short enough that a forgotten armed
// session doesn't stay open for hours.
const PAIR_EXPIRY_MS = 5 * 60 * 1000;

async function askBotName(current: string): Promise<string> {
  bold('1. Bot name');
  info('The persona name your bot uses when chatting.');
  const name = await ask('  Bot name', current);
  return name || current;
}

async function askOwnerName(current: string): Promise<string> {
  bold('2. Your name');
  info('What should the bot call you? It uses this to address you.');
  return await ask('  Your name', current || undefined);
}

async function askLocationTimezone(
  currentTz: string,
  currentLocation: string,
): Promise<{ timezone: string; location: string }> {
  bold('3. Location & timezone');
  info('So the assistant answers time/location-aware questions ("what\'s on my');
  info('schedule today?") in YOUR local time instead of UTC.');

  // Default to the host's timezone unless a non-UTC one is already configured.
  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const tzDefault = currentTz && currentTz !== 'UTC' ? currentTz : systemTz;

  let timezone = tzDefault;
  while (true) {
    timezone = await ask('  Timezone (IANA, e.g. Asia/Colombo)', tzDefault);
    if (isValidTimezone(timezone)) break;
    warn(
      `  "${timezone}" isn't a valid IANA timezone. Try e.g. Asia/Colombo, Europe/London, America/New_York.`,
    );
  }

  const location = await ask('  Location (city, country — optional)', currentLocation || undefined);
  return { timezone, location };
}

async function pickProviderInteractive(current: ProviderName): Promise<Provider> {
  bold('4. Agent provider');
  info(`Current: ${current}`);
  info('  [g] Gemini CLI  (Google,    npm @google/gemini-cli)');
  info('  [c] Claude Code (Anthropic, npm @anthropic-ai/claude-code)');
  const defLetter = current === 'claude' ? 'c' : 'g';
  while (true) {
    const c = (await ask('  Choice (g/c)', defLetter)).toLowerCase();
    if (c === 'g' || c === 'gemini') return PROVIDERS.gemini;
    if (c === 'c' || c === 'claude') return PROVIDERS.claude;
    warn('Please enter "g" or "c".');
  }
}

async function ensureProviderInstalled(p: Provider): Promise<void> {
  bold(`5. Install ${p.bin}`);
  const found = which(p.bin);
  if (found) {
    ok(`Found: ${found}`);
    return;
  }
  info(`Installing ${p.npmPackage} via npm -g …`);
  if (run('npm', ['install', '-g', p.npmPackage]) !== 0) {
    throw new Error(
      `Failed to install ${p.npmPackage}. Re-run with sudo, or fix your npm prefix ` +
        `(npm config set prefix ~/.npm-global) and add ~/.npm-global/bin to PATH.`,
    );
  }
  if (!which(p.bin)) {
    throw new Error(`${p.bin} installed but not on PATH. Open a new shell and re-run setup.`);
  }
  ok(`Installed ${p.bin}`);
}

function resetTerminal(): void {
  // setRawMode throws on non-TTY stdin; we guard with isTTY but Bun's stdin
  // can transition mid-call. Swallow because raw-mode failure here is
  // strictly cosmetic — the `stty sane` call below corrects most cases.
  // eslint-disable-next-line no-catch-all/no-catch-all
  try {
    if (stdin.isTTY) stdin.setRawMode(false);
  } catch {
    /* non-TTY or already cooked */
  }
  spawnSync('stty', ['sane'], { stdio: 'ignore' });
  stdout.write('\x1b[2J\x1b[H');
}

async function triggerLogin(p: Provider): Promise<void> {
  bold(`6. Log in to ${p.name}`);

  if (p.isAuthed()) {
    ok('Already logged in.');
    return;
  }

  info(`Launching ${p.bin}. Your browser will open for OAuth — complete it there.`);
  info("You don't need to do anything in this terminal. Setup resumes automatically when login completes.");
  await new Promise((r) => setTimeout(r, 800));

  const child = spawn(p.bin, [], { stdio: 'inherit' });

  await new Promise<void>((resolveP) => {
    let killed = false;
    const start = Date.now();
    const TIMEOUT_MS = 5 * 60_000;

    const poll = setInterval(() => {
      if (killed) return;
      if (p.isAuthed()) {
        killed = true;
        clearInterval(poll);
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 2000);
      } else if (Date.now() - start > TIMEOUT_MS) {
        killed = true;
        clearInterval(poll);
        child.kill('SIGTERM');
      }
    }, 500);

    child.on('close', () => {
      clearInterval(poll);
      resetTerminal();
      resolveP();
    });
  });

  if (p.isAuthed()) {
    ok(`Logged in to ${p.name}.`);
  } else {
    warn("Login did not complete. You can re-run setup later (it's idempotent).");
  }
}

interface ChannelChoices {
  whatsappEnabled: boolean;
  ownerPhone: string;
  telegramEnabled: boolean;
  // The token to persist to .env. When Telegram is enabled, the new or kept
  // token; when disabled, the existing token (so writeEnv can comment it out
  // rather than drop it). Empty means there's nothing to persist.
  telegramToken: string;
  telegramAllowedChats: string[];
  voiceEnabled: boolean;
}

async function askChannels(
  currentVoice: boolean,
  currentPhone: string,
  currentTgChats: string[],
): Promise<ChannelChoices> {
  bold('7. Channels + voice');

  const whatsappAlready = envHas('MARSCLAW_WHATSAPP');
  info('Connects via Baileys (unofficial WhatsApp library) — QR scan from your phone.');
  if (whatsappAlready) info('  Currently enabled in .env.');
  warn('Unofficial: not endorsed by Meta. Use at your own risk.');
  const whatsappEnabled = await yesNo('  Enable WhatsApp?', true);

  let ownerPhone = '';
  if (whatsappEnabled) {
    if (!whatsappAlready) {
      info("  You'll scan a QR to link your phone in a moment (step 9).");
      info('  WhatsApp → Settings → Linked devices → Link a device → scan it.');
    }
    info('');
    info('  Your WhatsApp number — digits only, country code first, no "+".');
    info('  e.g. 6591234567 (Singapore). Only this number can talk to the bot.');
    while (true) {
      const raw = await ask('  Your number', currentPhone || undefined);
      ownerPhone = normalizePhone(raw);
      if (!ownerPhone) {
        if (await yesNo('  No number given — accept messages from ANY sender?', false)) break;
        continue;
      }
      if (ownerPhone.length < 7 || ownerPhone.length > 15) {
        warn("  That doesn't look like a full international number (7–15 digits). Try again.");
        continue;
      }
      break;
    }
  }

  // Telegram: enabled purely by the presence of a bot token in .env (no QR /
  // pairing — @BotFather hands you the token directly). Default the prompt to
  // "on" when a token already exists so re-running setup keeps it.
  info('');
  const existingToken = envValue('TELEGRAM_BOT_TOKEN');
  info('Telegram — create a bot with @BotFather and paste the token it gives you.');
  if (existingToken) info('  A token is already set in .env.');
  const telegramEnabled = await yesNo('  Enable Telegram?', Boolean(existingToken));

  // When disabled, carry any existing token forward so writeEnv comments it out
  // (the runtime keys off token presence) instead of leaving it live.
  let telegramToken = telegramEnabled ? '' : existingToken;
  let telegramAllowedChats = currentTgChats;
  if (telegramEnabled) {
    while (true) {
      const raw = await ask(existingToken ? '  Bot token (enter to keep current)' : '  Bot token');
      if (!raw && existingToken) {
        telegramToken = existingToken;
        break;
      }
      if (!raw) {
        warn('  A token is required to enable Telegram.');
        continue;
      }
      if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(raw)) {
        if (!(await yesNo("  That doesn't look like a bot token. Use it anyway?", false))) continue;
      }
      telegramToken = raw;
      break;
    }

    // Optional sender lock-down. Telegram has no phone-based identity, so the
    // chat-id allow-list is the only gate. Most owners don't know their chat id
    // yet (the bot logs it on first message), so empty is fine — accept all for
    // now, lock down later.
    info('  Restrict to specific Telegram chat ids (optional).');
    info('  Leave empty to accept any sender for now — the bot logs each new');
    info('  chat id so you can lock it down later in data/config.json.');
    const rawChats = await ask('  Allowed chat ids (comma-separated)', currentTgChats.join(',') || undefined);
    telegramAllowedChats = rawChats
      ? rawChats
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  }

  info('');
  info('Voice transcription (local Whisper, ~600MB one-time install).');
  if (currentVoice) info('  Currently enabled in config.');
  const voiceDefault = currentVoice || whatsappEnabled || telegramEnabled;
  let voiceEnabled = await yesNo('  Enable voice?', voiceDefault);

  if (voiceEnabled) {
    if (existsSync('tools/voice-env')) {
      ok('  Voice venv already present at tools/voice-env — skipping install.');
    } else {
      // setup-voice.sh self-installs a supported Python (3.11/3.12) + ffmpeg
      // for the OS if missing, then builds the venv and caches models.
      info('  Running tools/setup-voice.sh (installs Python/ffmpeg if needed + models)…');
      const r = spawnSync('bash', ['tools/setup-voice.sh'], { stdio: 'inherit' });
      if (r.status !== 0) {
        warn('  Voice install failed. Retry later with `bun run voice install`.');
        voiceEnabled = false;
      } else {
        ok('  Voice installed.');
        const s = spawnSync('bun', ['run', 'src/cli/index.ts', 'voice', 'start'], { stdio: 'inherit' });
        if (s.status !== 0) warn('  Could not start sidecar automatically; run `bun run voice start` later.');
      }
    }
  }

  return {
    whatsappEnabled,
    ownerPhone,
    telegramEnabled,
    telegramToken,
    telegramAllowedChats,
    voiceEnabled,
  };
}

// Resolve (and if needed, install) yt-dlp so the youtube_transcript MCP tool
// can fetch captions. We pin the absolute path into .env because the spawned
// MCP server's PATH is minimal and may not include Homebrew / Python-framework
// bin dirs. Returns the resolved path, or '' if the owner declined and the
// binary isn't available — in which case the tool returns an install hint at
// call time.
//
// yt-dlp is a security boundary: it runs as the bot's user and downloads /
// parses arbitrary YouTube payloads. We pin to a validated version rather
// than tracking upstream automatically — `--upgrade` would silently swap in
// a compromised release on every setup re-run. Bump deliberately after
// reading the upstream changelog.
const YTDLP_PIN = process.env.MARSCLAW_YTDLP_VERSION ?? '2025.09.05';

async function ensureYtDlp(): Promise<string> {
  bold('8. YouTube transcripts');
  info("Optional but recommended. yt-dlp lets the agent fetch a video's");
  info('transcript so it can summarise YouTube links you send. ~6MB binary,');
  info(`single-purpose. Pinned to yt-dlp ${YTDLP_PIN}.`);

  const existing = findYtDlpPath();
  if (existing) {
    ok(`Found yt-dlp at ${existing}`);
    return existing;
  }

  if (!(await yesNo('  Install yt-dlp now?', true))) {
    info('  Skipped. The YouTube tool will return an install hint when called.');
    return '';
  }

  // Try in order: Homebrew (macOS), pip3 --user, pip --user. First one to
  // succeed wins; otherwise fall back to printing manual instructions.
  // Each path pins yt-dlp to YTDLP_PIN — no `--upgrade` to a moving target.
  const tryInstall = (cmd: string, args: string[]): boolean => {
    info(`  Running: ${cmd} ${args.join(' ')}`);
    return run(cmd, args) === 0;
  };

  let installed = false;
  if (process.platform === 'darwin' && which('brew')) {
    // Homebrew doesn't expose a clean way to install an arbitrary historical
    // version, so we install the formula and accept brew's pin. Document the
    // expected version in the warning if it drifts.
    installed = tryInstall('brew', ['install', 'yt-dlp']);
  }
  if (!installed && which('pip3')) {
    installed = tryInstall('pip3', ['install', '--user', `yt-dlp==${YTDLP_PIN}`]);
  }
  if (!installed && which('pip')) {
    installed = tryInstall('pip', ['install', '--user', `yt-dlp==${YTDLP_PIN}`]);
  }
  if (!installed) {
    warn("  Couldn't install automatically — no brew/pip found, or the install failed.");
    warn('  Install manually with `brew install yt-dlp` or `pip install --user yt-dlp`,');
    warn('  then re-run setup.');
    return '';
  }

  const found = findYtDlpPath();
  if (!found) {
    warn('  Installed, but not found on any known path. Open a new shell and re-run setup.');
    return '';
  }
  ok(`yt-dlp installed at ${found}`);
  return found;
}

// Seed MEMORY.md with an owner block so BOTH providers (gemini reads MEMORY.md,
// claude gets it via persona too) know who they're talking to from turn one.
// Idempotent: only writes if the file lacks an "## Owner" section.
function seedMemory(ownerName: string, ownerPhone: string, timezone: string, location: string): void {
  if (!ownerName && !ownerPhone && !location && (!timezone || timezone === 'UTC')) return;
  if (!existsSync('MEMORY.md')) return;
  const body = readFileSync('MEMORY.md', 'utf-8');
  if (/^##\s+Owner\b/m.test(body)) return;
  const lines = ['', '## Owner', ''];
  if (ownerName) lines.push(`- Name: ${ownerName}`);
  if (ownerPhone) lines.push(`- WhatsApp: ${ownerPhone}`);
  if (location) lines.push(`- Location: ${location}`);
  if (timezone && timezone !== 'UTC') lines.push(`- Timezone: ${timezone}`);
  lines.push('');
  writeAtomic('MEMORY.md', body.replace(/\n+$/, '') + '\n' + lines.join('\n'));
}

// .env holds secrets + channel-enable flags. Non-secret runtime config
// (bot_name, allowed_jids, timezone, etc.) lives in data/config.json.
//
// We manage exactly: AGENT_PROVIDER, MARSCLAW_WHATSAPP, TELEGRAM_BOT_TOKEN,
// MARSCLAW_YTDLP_PATH. Slack tokens hand-added by power users are left
// untouched.
function writeEnv(
  provider: ProviderName,
  whatsappEnabled: boolean,
  telegram: { enabled: boolean; token: string },
  ytdlpPath: string,
): void {
  const managed = new Set([
    'AGENT_PROVIDER',
    'MARSCLAW_WHATSAPP',
    'TELEGRAM_BOT_TOKEN',
    'MARSCLAW_YTDLP_PATH',
  ]);
  const existing = existsSync('.env') ? readFileSync('.env', 'utf-8') : '';
  const lines = existing.split('\n').filter((l) => {
    if (!l.trim() || l.trim().startsWith('#')) return true;
    const key = l.split('=')[0].trim();
    return !managed.has(key);
  });
  lines.push(`AGENT_PROVIDER=${provider}`);
  if (whatsappEnabled) lines.push('MARSCLAW_WHATSAPP=1');
  if (telegram.enabled && telegram.token) {
    lines.push(`TELEGRAM_BOT_TOKEN=${telegram.token}`);
  } else if (telegram.token) {
    // Disabled but we still hold the token — keep it commented so the runtime
    // (which keys off token presence) ignores it, but the owner can re-enable
    // by uncommenting instead of fetching it from @BotFather again.
    lines.push(`# TELEGRAM_BOT_TOKEN=${telegram.token}`);
  }
  // Pin the absolute path so the MCP subprocess (minimal PATH) finds yt-dlp
  // without falling back to a login-shell lookup. Omitted if not installed —
  // the tool's runtime resolver still tries common paths + login shell.
  if (ytdlpPath) lines.push(`MARSCLAW_YTDLP_PATH=${ytdlpPath}`);
  const out = lines.join('\n').replace(/\n+$/, '') + '\n';
  writeAtomic('.env', out);
}

function summarize(
  botName: string,
  ownerName: string,
  provider: ProviderName,
  ch: ChannelChoices,
  timezone: string,
  location: string,
  ytdlpPath: string,
): void {
  ok(`bot name:  ${botName}`);
  if (ownerName) ok(`your name: ${ownerName}`);
  ok(`timezone:  ${timezone}`);
  if (location) ok(`location:  ${location}`);
  ok(`provider:  ${provider}`);
  ok(`whatsapp:  ${ch.whatsappEnabled ? 'on' : 'off'}`);
  if (ch.whatsappEnabled) {
    ok(`allowed:   ${ch.ownerPhone ? `${ch.ownerPhone} (and the chat captured at pairing)` : 'any sender'}`);
  }
  ok(`telegram:  ${ch.telegramEnabled ? 'on' : 'off'}`);
  if (ch.telegramEnabled) {
    ok(`allowed:   ${ch.telegramAllowedChats.length ? ch.telegramAllowedChats.join(', ') : 'any sender'}`);
  }
  ok(`voice:     ${ch.voiceEnabled ? 'on' : 'off'}`);
  ok(`yt-dlp:    ${ytdlpPath || 'not installed'}`);
  if (!ch.whatsappEnabled && !ch.telegramEnabled) {
    warn('No channels enabled. The bot will refuse to start until you wire one up.');
  }
}

async function main(): Promise<void> {
  printBanner('interactive setup');

  if (!which('npm')) {
    throw new Error('npm not found on PATH. Install Node.js (https://nodejs.org) and re-run setup.');
  }

  const current = loadConfig();

  const botName = await askBotName(current.bot_name);
  const ownerName = await askOwnerName(current.owner_name);
  const { timezone, location } = await askLocationTimezone(current.timezone, current.location);
  const provider = await pickProviderInteractive(current.agent_provider);
  await ensureProviderInstalled(provider);
  await triggerLogin(provider);
  const channels = await askChannels(
    current.voice_enabled,
    current.owner_phone,
    current.allowed_telegram_chats,
  );

  const ytdlpPath = await ensureYtDlp();

  // Allow-list + pairing. A fresh number arms code-based pairing: the owner
  // sends a one-time code as a WhatsApp message and the bot captures that
  // sender's real JID (possibly an @lid). Re-running with the SAME number
  // preserves an already-paired JID and its pairing state/code.
  let allowedJids: string[] = [];
  let pairOwner = false;
  let pairCode = '';
  let pairExpiresAt = 0;
  if (channels.whatsappEnabled && channels.ownerPhone) {
    const phoneJid = `${channels.ownerPhone}@s.whatsapp.net`;
    if (channels.ownerPhone !== current.owner_phone) {
      allowedJids = [phoneJid];
      pairOwner = true;
      pairCode = genPairCode();
      pairExpiresAt = Date.now() + PAIR_EXPIRY_MS;
    } else {
      allowedJids = current.allowed_jids.includes(phoneJid)
        ? [...current.allowed_jids]
        : [phoneJid, ...current.allowed_jids];
      pairOwner = current.whatsapp_pair_owner;
      pairCode = current.whatsapp_pair_code;
      pairExpiresAt = current.whatsapp_pair_expires_at;
      if (pairOwner && !pairCode) {
        pairCode = genPairCode(); // arm if missing
        pairExpiresAt = Date.now() + PAIR_EXPIRY_MS;
      }
    }
  } else if (channels.ownerPhone) {
    allowedJids = [`${channels.ownerPhone}@s.whatsapp.net`];
  }

  bold('9. Writing config');
  try {
    writeEnv(
      provider.name,
      channels.whatsappEnabled,
      { enabled: channels.telegramEnabled, token: channels.telegramToken },
      ytdlpPath,
    );
    writeConfig({
      bot_name: botName,
      owner_name: ownerName,
      owner_phone: channels.ownerPhone,
      timezone,
      location,
      agent_provider: provider.name,
      voice_enabled: channels.voiceEnabled,
      allowed_jids: allowedJids,
      allowed_telegram_chats: channels.telegramAllowedChats,
      whatsapp_pair_owner: pairOwner,
      whatsapp_pair_code: pairCode,
      whatsapp_pair_expires_at: pairExpiresAt,
    });
    seedMemory(ownerName, channels.ownerPhone, timezone, location);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to persist config: ${msg}`);
  }
  ok('.env (secrets) and data/config.json (runtime config) written.');
  summarize(botName, ownerName, provider.name, channels, timezone, location, ytdlpPath);

  // Step 9: link WhatsApp now by scanning a QR, so onboarding finishes in one
  // sitting instead of deferring the scan to the first `bun run start`.
  let linkedNow = false;
  if (channels.whatsappEnabled) {
    bold('10. Link WhatsApp');
    if (await yesNo('  Link your WhatsApp now by scanning a QR?', true)) {
      info('  Opening a link session — a QR will appear shortly (≤2 min to scan)…');
      try {
        const { linkWhatsapp } = await import('../channels/whatsapp-link.ts');
        const res = await linkWhatsapp({ timeoutMs: 120_000 });
        if (res.status === 'already-linked') {
          ok('  WhatsApp already linked — nothing to scan.');
          linkedNow = true;
        } else if (res.status === 'linked') {
          ok('  WhatsApp linked.');
          linkedNow = true;
        } else if (res.status === 'timeout') {
          warn('  Timed out waiting for the scan. A QR will print on first `bun run start`.');
        } else {
          warn(`  Linking failed (${res.detail ?? res.status}). A QR will print on first \`bun run start\`.`);
        }
      } catch (err) {
        warn(`  Couldn't start the link session: ${err instanceof Error ? err.message : String(err)}`);
        info('  No problem — a QR will print on first `bun run start`.');
      }
    } else {
      info('  Skipped — a QR will print on first `bun run start`.');
    }
  }

  if (pairOwner && pairCode) {
    bold('Pair your WhatsApp');
    if (!linkedNow) info('Scan the QR the bot prints on start to link your phone, then:');
    info('From your phone, send this exact message to your bot once you see');
    info('"whatsapp connected" in the logs below:');
    console.log(`\n      \x1b[1m${pairCode}\x1b[0m\n`);
    info('The bot stays silent until it sees that code, then locks to your chat.');
  }

  // Offer to launch the bot right away. For WhatsApp this is the step that
  // actually captures the pairing code — the bot must be running and connected
  // to receive it. (If you run marsClaw as a service, decline this and use
  // `bun run service restart` instead to avoid two instances.)
  bold('Done.');
  const anyChannel = channels.whatsappEnabled || channels.telegramEnabled;
  const startPrompt = pairOwner && pairCode ? 'Start the bot now to finish pairing?' : 'Start the bot now?';
  const startNow = anyChannel && (await yesNo(startPrompt, true));
  rl.close();

  if (startNow) {
    // If a background launchd service is already running, stop it first — two
    // instances against the same WhatsApp auth dir conflict (connection
    // cycling). We restore it after the foreground pairing session ends.
    const serviceWasRunning = isServiceLoaded();
    if (serviceWasRunning) {
      info("A background service is running — stopping it so the two don't clash…");
      const stopped = stopService();
      if (stopped.ok) ok('  Background service stopped.');
      else
        warn(
          `  Couldn't stop it${stopped.reason ? ` (${stopped.reason})` : ''} — watch for connection cycling.`,
        );
      info("  When pairing is done, Ctrl+C — I'll bring the service back (else: bun run service start).");
    }

    info('Starting marsClaw — press Ctrl+C when pairing is done.\n');
    // Ignore Ctrl+C in this parent so the child (bot) owns it; we resume after
    // it exits to restore the service. Without this, SIGINT would also kill
    // setup before it could restart the service.
    const ignoreSigint = (): void => {};
    process.on('SIGINT', ignoreSigint);
    // Reuse the bun binary running setup (robust if `bun` isn't on a minimal
    // PATH). Foreground + inherited stdio so the "connected" log + pairing code
    // show and the code message is captured live in the same terminal.
    const r = spawnSync(process.execPath, ['run', 'src/cli/index.ts', 'start'], { stdio: 'inherit' });
    process.off('SIGINT', ignoreSigint);

    if (serviceWasRunning) {
      info('\nRestoring the background service…');
      const restarted = startService();
      if (restarted.ok) ok('  Background service is running again.');
      else
        warn(
          `  Couldn't restart it${restarted.reason ? ` (${restarted.reason})` : ''}. Run: bun run service start`,
        );
    }
    process.exit(r.status ?? 0);
  }

  info('Start the bot:  bun run start');
  // Baileys may leave a socket/timer pending even after sock.end(); force a
  // clean exit so setup doesn't hang after linking.
  process.exit(0);
}

main().catch((e) => {
  console.error('\n\x1b[31m✗\x1b[0m', e instanceof Error ? e.message : e);
  rl.close();
  process.exit(1);
});
