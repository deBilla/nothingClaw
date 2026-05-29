// Slack adapter — Bolt with Socket Mode (no public webhook needed).
//
// Requires a Slack app with:
//   - Socket Mode enabled
//   - App-level token (xapp-…) with scope: connections:write
//   - Bot token (xoxb-…) with scopes: chat:write, im:history, im:read, im:write,
//     app_mentions:read (for channel mentions, optional)
//   - Event subscriptions: message.im (DMs), app_mention (channels)

import { App, LogLevel } from '@slack/bolt';
import { loadConfig } from '../lib/config.ts';
import { log } from '../lib/log.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import type { Channel, ChannelInit, SendOpts } from './types.ts';

export interface SlackOptions extends ChannelInit {
  botToken: string;
  appToken: string;
}

const PREFIX = 'slack:';

export async function createSlackChannel(opts: SlackOptions): Promise<Channel> {
  const app = new App({
    token: opts.botToken,
    appToken: opts.appToken,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });

  // Sender allow-list. Non-empty = reject any Slack user not listed. Empty =
  // accept all, warning once per new user id so the owner can lock it down.
  const config = loadConfig();
  const allowed = new Set(config.allowed_slack_users.map((u) => String(u).trim()).filter(Boolean));
  const warnedOpen = new Set<string>();
  function senderAllowed(user: string | undefined): boolean {
    const uid = String(user ?? '');
    if (allowed.size === 0) {
      if (uid && !warnedOpen.has(uid)) {
        warnedOpen.add(uid);
        log.warn('slack allow-list disabled — accepting from any user', {
          user: uid,
          hint: `set allowed_slack_users to ["${uid}"] in data/config.json to restrict`,
        });
      }
      return true;
    }
    if (allowed.has(uid)) return true;
    log.warn('slack rejected — sender not in allow-list', {
      user: uid,
      hint: 'add this user id to allowed_slack_users in data/config.json to grant access',
    });
    return false;
  }
  // Per-sender rate limit. A Slack workspace member who knows the bot is up
  // can otherwise drive arbitrary agent turns; Socket Mode delivers everything
  // they DM. Same defaults as the other channels (10/min, 60/hr).
  const limiter =
    config.rate_limit_per_minute > 0 || config.rate_limit_per_hour > 0
      ? new RateLimiter({
          perMinute: config.rate_limit_per_minute || Infinity,
          perHour: config.rate_limit_per_hour || Infinity,
        })
      : null;
  function rateOk(key: string): boolean {
    if (!limiter) return true;
    const v = limiter.check(key);
    if (!v.ok) {
      log.warn('slack rate-limited', { key, reason: v.reason, retryAfterMs: v.retryAfterMs });
      return false;
    }
    return true;
  }

  app.message(async ({ message }) => {
    if ('subtype' in message && message.subtype) return; // edits, joins, bot-sent, etc.
    const m = message as { text?: string; channel?: string; user?: string; bot_id?: string };
    if (m.bot_id) return;
    if (!m.text || !m.channel) return;
    if (!senderAllowed(m.user)) return;
    if (!rateOk(m.user ?? m.channel)) return;
    const threadId = `${PREFIX}${m.channel}`;
    try {
      await opts.onMessage(threadId, m.text);
    } catch (err) {
      log.error('slack handler error', { err });
    }
  });

  app.event('app_mention', async ({ event }) => {
    const e = event as { text?: string; channel?: string; user?: string };
    if (!e.text || !e.channel) return;
    if (!senderAllowed(e.user)) return;
    if (!rateOk(e.user ?? e.channel)) return;
    const threadId = `${PREFIX}${e.channel}`;
    try {
      await opts.onMessage(threadId, e.text);
    } catch (err) {
      log.error('slack mention handler error', { err });
    }
  });

  app.error(async (err) => {
    log.error('slack error', { err });
  });

  await app.start();
  log.info('slack connected (socket mode)');

  return {
    async send(threadId: string, text: string, _opts?: SendOpts) {
      // _opts.audioPath is silently ignored — Slack file uploads aren't wired yet,
      // so voice replies fall back to the spoken text.
      if (!threadId.startsWith(PREFIX)) {
        throw new Error(`slack channel cannot send to thread ${threadId}`);
      }
      const channel = threadId.slice(PREFIX.length);
      await app.client.chat.postMessage({ channel, text });
    },
  };
}
