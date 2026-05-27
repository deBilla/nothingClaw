import { copyFileSync, existsSync } from 'node:fs';
import { initDb } from './db/connection.ts';
import {
  incrementOutboxAttempt,
  markOutboxDelivered,
  markOutboxFailed,
  MAX_ATTEMPTS,
  takePendingOutbox,
} from './db/outbox.ts';
import { createTelegramChannel } from './channels/telegram.ts';
import { ChannelRouter } from './channels/router.ts';
import { handleMessage } from './agent.ts';
import { printRunningBanner } from './cli/branding.ts';
import { log } from './lib/log.ts';
import { loadConfig } from './lib/config.ts';
import { enforceStartupBackoff, resetCircuitBreaker } from './lib/circuit-breaker.ts';
import { pauseTypingAfterDelivery, shutdownTyping } from './lib/typing.ts';
import { startBackupSchedule, stopBackupSchedule } from './lib/backup.ts';
import { startHealthServer, stopHealthServer } from './lib/health-server.ts';

// FIRST thing on boot: if we've been crash-looping, sleep before doing
// anything that might burn API quota. resetCircuitBreaker() in shutdown()
// wipes the counter on clean exits.
await enforceStartupBackoff();

const config = loadConfig();

// Ensure local-only memory file exists before any agent runs against it.
if (!existsSync('MEMORY.md') && existsSync('MEMORY.template.md')) {
  copyFileSync('MEMORY.template.md', 'MEMORY.md');
}

const db = initDb();
const inFlight = new Map<string, Promise<void>>();
const router = new ChannelRouter();

// Single dispatcher all channels share. Serializes per-thread so we never run
// two agent processes for the same chat at once.
const onMessage = (threadId: string, text: string) => {
  const prev = inFlight.get(threadId) ?? Promise.resolve();
  const next = prev.then(() => handleMessage(db, router, threadId, text)).catch((err) => {
    log.error('agent handler failed', { threadId, err });
  });
  inFlight.set(
    threadId,
    next.finally(() => {
      if (inFlight.get(threadId) === next) inFlight.delete(threadId);
    }),
  );
};

// Telegram
if (process.env.TELEGRAM_BOT_TOKEN) {
  const ch = createTelegramChannel({ token: process.env.TELEGRAM_BOT_TOKEN, onMessage });
  router.register('telegram', ch);
  log.info('channel enabled', { name: 'telegram' });
}

// Slack (lazy-loaded so non-Slack users don't pay the import cost)
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
  const { createSlackChannel } = await import('./channels/slack.ts');
  const ch = await createSlackChannel({
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    onMessage,
  });
  router.register('slack', ch);
  log.info('channel enabled', { name: 'slack' });
}

// WhatsApp (Baileys, QR-scan auth on first run)
if (process.env.MARSCLAW_WHATSAPP === '1') {
  const { createWhatsappChannel } = await import('./channels/whatsapp.ts');
  const ch = await createWhatsappChannel({ onMessage });
  router.register('whatsapp', ch);
  log.info('channel enabled', { name: 'whatsapp' });
  if (config.allowed_jids.length === 0) {
    log.warn('WhatsApp allow-list disabled — accepting from any sender. Set allowed_jids in data/config.json to restrict.');
  } else {
    log.info('WhatsApp allow-list active', { count: config.allowed_jids.length });
  }
}

if (router.list().length === 0) {
  log.fatal('No channels enabled. Run `bun run setup` to wire one up.');
  process.exit(1);
}

// Outbox drain — delivers messages the agent queued via mcp send_message / speak.
// Two-tier polling: fast 250ms while there's work to drain, slow 5s when idle.
// One tick at a time, scheduled via recursive setTimeout — no race on the same row.
const FAST_TICK_MS = 250;
const IDLE_TICK_MS = 5000;
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

async function drainOnce(): Promise<number> {
  const pending = takePendingOutbox(db, 20);
  let delivered = 0;
  for (const row of pending) {
    try {
      const sendOpts: { audioPath?: string; filePath?: string; fileName?: string } = {};
      if (row.audio_path) sendOpts.audioPath = row.audio_path;
      if (row.file_path) sendOpts.filePath = row.file_path;
      if (row.file_name) sendOpts.fileName = row.file_name;
      await router.send(
        row.thread_id,
        row.text,
        Object.keys(sendOpts).length ? sendOpts : undefined,
      );
      markOutboxDelivered(db, row.id);
      // Briefly pause the typing indicator so the client renders cleanly.
      pauseTypingAfterDelivery(row.thread_id);
      delivered++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const newAttempts = row.attempts + 1;
      if (newAttempts >= MAX_ATTEMPTS) {
        markOutboxFailed(db, row.id, msg);
        log.error('outbox delivery permanently failed', {
          id: row.id,
          thread: row.thread_id,
          attempts: newAttempts,
          err: msg,
        });
      } else {
        incrementOutboxAttempt(db, row.id, msg);
        log.warn('outbox delivery failed — will retry', {
          id: row.id,
          thread: row.thread_id,
          attempts: newAttempts,
          err: msg,
        });
      }
    }
  }
  return delivered;
}

function scheduleNextDrain(intervalMs: number): void {
  if (shuttingDown) return;
  drainTimer = setTimeout(async () => {
    const delivered = await drainOnce();
    scheduleNextDrain(delivered > 0 ? FAST_TICK_MS : IDLE_TICK_MS);
  }, intervalMs);
}

scheduleNextDrain(IDLE_TICK_MS);
startBackupSchedule();
const healthServer = startHealthServer({ db, channels: router.list() });

const shutdown = () => {
  shuttingDown = true;
  if (drainTimer) clearTimeout(drainTimer);
  stopBackupSchedule();
  stopHealthServer(healthServer);
  shutdownTyping();
  db.close();
  resetCircuitBreaker();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

printRunningBanner(router.list(), config.agent_provider);
