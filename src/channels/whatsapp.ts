// WhatsApp adapter via Baileys (unofficial, QR-scan auth).
//
// First run: prints a QR code to terminal. Scan it with WhatsApp on your phone
// (Linked devices → Link a device). Auth state is saved to ./data/whatsapp-auth
// for subsequent runs.

import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason,
  type WAMessage,
  type WAMessageContent,
  type WASocket,
} from 'baileys';
import type { Boom } from '@hapi/boom';
import type { Channel, ChannelInit, SendOpts } from './types.ts';
import { transcribe } from '../voice.ts';
import { log } from '../lib/log.ts';
import { loadConfig, writeConfig } from '../lib/config.ts';
import { isSafeAttachmentName } from '../lib/attachment-safety.ts';
import { gateCommand } from '../lib/command-gate.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { interruptThread } from '../providers/claude-sdk.ts';

const STOP_RE = /^\s*(stop|abort|cancel|wait\s+stop|nvm|nevermind|never\s+mind)\s*[!.\s]*$/i;

const PREFIX = 'whatsapp:';
const AUTH_DIR = process.env.MARSCLAW_WHATSAPP_AUTH ?? 'data/whatsapp-auth';
const MEDIA_DIR = process.env.MARSCLAW_WHATSAPP_MEDIA ?? 'data/whatsapp-media';
const VERBOSE = process.env.MARSCLAW_WHATSAPP_VERBOSE === '1';
// Marker file written when the session is logged out and the user must
// re-scan the QR. Cleared on successful reconnect. External monitors
// (the health endpoint, a phone widget, a cron-driven email script) can
// watch this file to alert the operator.
const REAUTH_MARKER = process.env.MARSCLAW_WHATSAPP_REAUTH_MARKER ?? 'data/whatsapp-needs-reauth';

// pino is used ONLY to silence Baileys' chatty internal logger. Our own
// logging goes through src/lib/log.ts.
const baileysLogger = pino({ level: VERBOSE ? 'info' : 'silent' });

async function tryDownloadAudio(msg: WAMessage): Promise<string | null> {
  if (!msg.message?.audioMessage) return null;
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    mkdirSync(MEDIA_DIR, { recursive: true });
    const mime = msg.message.audioMessage.mimetype ?? 'audio/ogg';
    const ext = mime.includes('ogg') ? 'ogg' : (mime.split('/').pop() ?? 'audio').split(';')[0];
    const id = (msg.key.id ?? `${Date.now()}`).replace(/[^a-zA-Z0-9-]/g, '_');
    const filePath = resolve(MEDIA_DIR, `${id}.${ext}`);
    writeFileSync(filePath, buffer as Buffer);
    return filePath;
  } catch (err) {
    log.warn('whatsapp audio download failed', { err });
    return null;
  }
}

async function tryDownloadImage(msg: WAMessage): Promise<string | null> {
  if (!msg.message?.imageMessage) return null;
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    mkdirSync(MEDIA_DIR, { recursive: true });
    const mime = msg.message.imageMessage.mimetype ?? 'image/jpeg';
    const ext = (mime.split('/').pop() ?? 'jpg').split(';')[0];
    const id = (msg.key.id ?? `${Date.now()}`).replace(/[^a-zA-Z0-9-]/g, '_');
    const filePath = resolve(MEDIA_DIR, `${id}.${ext}`);
    writeFileSync(filePath, buffer as Buffer);
    return filePath;
  } catch (err) {
    log.warn('whatsapp image download failed', { err });
    return null;
  }
}

async function tryDownloadDocument(msg: WAMessage): Promise<{ path: string; fileName: string } | null> {
  const doc = msg.message?.documentMessage ?? msg.message?.documentWithCaptionMessage?.message?.documentMessage;
  if (!doc) return null;
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    mkdirSync(MEDIA_DIR, { recursive: true });
    const id = (msg.key.id ?? `${Date.now()}`).replace(/[^a-zA-Z0-9-]/g, '_');
    // Sanitize the inbound filename. Even after isSafeAttachmentName, we
    // sanitise non-alphanum chars for cosmetic safety, but only AFTER the
    // safety predicate has cleared traversal sequences.
    const rawFileName = doc.fileName ?? '';
    const safeName = isSafeAttachmentName(rawFileName) ? rawFileName : '';
    if (rawFileName && !safeName) {
      log.warn('whatsapp document had unsafe filename — using mime-derived fallback', { rawFileName });
    }
    const sanitised = safeName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const mime = doc.mimetype ?? 'application/octet-stream';
    const mimeExt = (mime.split('/').pop() ?? 'bin').split(';')[0];
    const ext = sanitised.includes('.') ? sanitised.split('.').pop()! : mimeExt;
    const filePath = resolve(MEDIA_DIR, `${id}.${ext}`);
    writeFileSync(filePath, buffer as Buffer);
    return { path: filePath, fileName: sanitised || `document.${ext}` };
  } catch (err) {
    log.warn('whatsapp document download failed', { err });
    return null;
  }
}

function extractText(m: WAMessageContent | null | undefined): string {
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.ephemeralMessage?.message?.conversation ||
    m.ephemeralMessage?.message?.extendedTextMessage?.text ||
    m.viewOnceMessage?.message?.conversation ||
    m.viewOnceMessage?.message?.extendedTextMessage?.text ||
    ''
  );
}

// Digits in a JID's user part (strips the @domain and any :device suffix).
// For @s.whatsapp.net DMs this is the phone number; for @lid it's an opaque id.
function jidDigits(jid: string): string {
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

export async function createWhatsappChannel(opts: ChannelInit): Promise<Channel> {
  mkdirSync(AUTH_DIR, { recursive: true });
  const config = loadConfig();
  const allowedJids = new Set(config.allowed_jids);
  const ownerPhone = config.owner_phone;
  // One-shot owner pairing. WhatsApp may deliver the owner's DMs under an
  // opaque @lid that a phone-derived JID can't match. While pairing is active,
  // the bot stays silent to everyone (it runs as the owner's own account, so
  // unrelated contacts may be messaging it) and only reacts to the message
  // carrying the pairing code — then it captures that sender's real JID.
  let pairOwner = config.whatsapp_pair_owner;
  let pairCode = config.whatsapp_pair_code;
  const voiceEnabled = config.voice_enabled;

  // Exact JID match (existing behaviour) OR phone-number match against the
  // configured owner number (covers @s.whatsapp.net device-suffix variants).
  const isAllowed = (jid: string): boolean => {
    if (allowedJids.size === 0) return true; // empty = accept all (warned at boot)
    if (allowedJids.has(jid)) return true;
    if (ownerPhone && jidDigits(jid) === ownerPhone) return true;
    return false;
  };

  // Records the sender's real JID into the allow-list and persists it. Called
  // once, when the inbound DM carrying the pairing code arrives.
  const captureOwner = (jid: string): void => {
    pairOwner = false;
    pairCode = '';
    const added = !allowedJids.has(jid);
    if (added) allowedJids.add(jid);
    try {
      writeConfig({ allowed_jids: [...allowedJids], whatsapp_pair_owner: false, whatsapp_pair_code: '' });
      log.warn('whatsapp owner paired — allow-list locked to this sender', { jid, added });
    } catch (err) {
      log.error('whatsapp failed to persist paired owner', { jid, err });
    }
  };
  const limiter =
    config.rate_limit_per_minute > 0 || config.rate_limit_per_hour > 0
      ? new RateLimiter({
          perMinute: config.rate_limit_per_minute || Infinity,
          perHour: config.rate_limit_per_hour || Infinity,
        })
      : null;
  let sock: WASocket = await connect(opts);
  let consecutiveFailures = 0;

  async function connect(opts: ChannelInit): Promise<WASocket> {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const s = makeWASocket({ auth: state, logger: baileysLogger });

    s.ev.on('creds.update', saveCreds);

    s.ev.on('connection.update', (u) => {
      if (u.qr) {
        log.info('whatsapp QR code — scan from your phone (Settings → Linked devices → Link a device)');
        qrcode.generate(u.qr, { small: true });
      }
      if (u.connection === 'open') {
        consecutiveFailures = 0;
        // Successful reconnect — clear any stale re-auth marker.
        try {
          if (existsSync(REAUTH_MARKER)) unlinkSync(REAUTH_MARKER);
        } catch (err) {
          log.debug('failed to clear reauth marker', { err });
        }
        log.info('whatsapp connected');
        // If owner-pairing is still armed, surface the code right here — this
        // is exactly when the operator is watching the logs (e.g. setup just
        // auto-started the bot). They send this code from their phone to lock
        // the allow-list to their chat.
        if (pairOwner && pairCode) {
          log.warn('whatsapp pairing armed — send this code from your phone to finish pairing', {
            code: pairCode,
          });
        }
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        consecutiveFailures++;

        if (loggedOut) {
          // Persist a marker file so external monitors / a phone widget /
          // a cron-driven email can alert the operator. Without this the
          // session being dead is invisible until you message yourself
          // and notice no reply.
          try {
            writeFileSync(
              REAUTH_MARKER,
              `WhatsApp logged out at ${new Date().toISOString()}.\n` +
                `To re-link:\n  1. Delete ${AUTH_DIR}/\n  2. Restart the bot (bun run start)\n  3. Scan the QR shown in terminal\n`,
            );
          } catch (err) {
            log.debug('failed to write reauth marker', { err });
          }
          log.warn(
            '⚠️  whatsapp logged out — manual re-link required',
            { marker: REAUTH_MARKER, fix: `delete ${AUTH_DIR}/ and restart` },
          );
          return;
        }

        if (consecutiveFailures >= 5) {
          log.error('whatsapp giving up after 5 failed connection attempts', {
            code,
            hints: 'too many linked devices (max 4) / blocked link / IP region',
          });
          return;
        }

        log.warn('whatsapp disconnected — reconnecting', { code, attempt: consecutiveFailures });
        setTimeout(async () => {
          sock = await connect(opts);
        }, 2000);
      }
    });

    s.ev.on('messages.upsert', async ({ messages, type }) => {
      // 'notify' = live new message. 'append' = history sync after pairing —
      // do NOT auto-reply to those, they're things the user already sent/received.
      if (type !== 'notify') {
        if (VERBOSE) log.debug('whatsapp ignored non-notify batch', { count: messages.length, type });
        return;
      }
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.key.remoteJid) continue;
        // skip groups by default — only DMs (1:1 chats end in @s.whatsapp.net)
        if (msg.key.remoteJid.endsWith('@g.us')) continue;
        // skip status broadcasts
        if (msg.key.remoteJid === 'status@broadcast') continue;

        // Code-based owner pairing. While active, ONLY the message whose text
        // contains the pairing code gets through — its sender's real JID
        // (possibly an @lid) is captured and locked in. Every other message is
        // ignored silently: the bot runs as the owner's account, so its normal
        // contacts must not get auto-replies during the pairing window.
        if (pairOwner && pairCode) {
          const candidate = extractText(msg.message).trim().toLowerCase();
          if (candidate && candidate.includes(pairCode.toLowerCase())) {
            captureOwner(msg.key.remoteJid);
            try {
              await sock.sendMessage(msg.key.remoteJid, {
                text: "✅ Paired. I'll only respond to this chat now — you can delete the code message.",
              });
            } catch (err) {
              log.warn('whatsapp pair-ack send failed', { err });
            }
          } else {
            log.info('whatsapp awaiting pairing code — ignoring message', { jid: msg.key.remoteJid });
          }
          continue;
        }

        // Sender allow-list. Empty set = accept all (warned at boot).
        if (!isAllowed(msg.key.remoteJid)) {
          log.warn('whatsapp rejected — sender not in allow-list', {
            jid: msg.key.remoteJid,
            hint: 'add this JID to allowed_jids in data/config.json',
          });
          continue;
        }

        // Per-sender rate limit. Silently drop excess messages so we don't
        // turn a flood into a flood of explanatory replies.
        if (limiter) {
          const verdict = limiter.check(msg.key.remoteJid);
          if (!verdict.ok) {
            log.warn('whatsapp rate-limited', {
              jid: msg.key.remoteJid,
              reason: verdict.reason,
              retryAfterMs: verdict.retryAfterMs,
            });
            continue;
          }
        }

        const baseText = extractText(msg.message);

        // User-initiated interrupt. Single-word "stop" / "abort" / "cancel"
        // (case-insensitive, trailing punctuation tolerated) tears down the
        // in-flight session WITHOUT queueing behind it. The agent loop
        // currently serialises per-thread, so without this, "stop" would
        // wait for the very turn it's trying to halt.
        if (baseText && STOP_RE.test(baseText)) {
          const threadId = `${PREFIX}${msg.key.remoteJid}`;
          const interrupted = interruptThread(threadId);
          const reply = interrupted ? 'Stopped.' : 'Nothing in progress.';
          log.info('whatsapp interrupt', { jid: msg.key.remoteJid, interrupted });
          try {
            await sock.sendMessage(msg.key.remoteJid, { text: reply });
          } catch (err) {
            log.warn('whatsapp interrupt-ack send failed', { err });
          }
          continue;
        }

        const imagePath = await tryDownloadImage(msg);
        const audioPath = await tryDownloadAudio(msg);
        const document = await tryDownloadDocument(msg);

        // Drop slash-commands meant for interactive CLIs (`/help`, `/clear`)
        // before they reach the agent.
        if (baseText && gateCommand(baseText) === 'filter') {
          log.debug('whatsapp filtered slash-command', { jid: msg.key.remoteJid, cmd: baseText.split(/\s/)[0] });
          continue;
        }

        // Transcribe audio if voice support is enabled + whisper sidecar is up.
        let voiceText = '';
        if (audioPath && voiceEnabled) {
          try {
            const t0 = Date.now();
            voiceText = await transcribe(audioPath);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            log.info('whatsapp transcribed audio', {
              path: audioPath,
              elapsed,
              preview: voiceText.slice(0, 80),
            });
          } catch (err) {
            log.warn('whatsapp transcribe failed', { err });
            voiceText = '(voice message — transcription failed; ask the user to type)';
          }
        } else if (audioPath) {
          log.debug('whatsapp audio received but voice disabled');
        }

        if (!baseText && !imagePath && !voiceText && !document) {
          const kind = msg.message ? Object.keys(msg.message)[0] : 'empty';
          log.debug('whatsapp skipped non-text', { jid: msg.key.remoteJid, kind });
          continue;
        }

        // Assemble the message payload the agent will see.
        const parts: string[] = [];
        if (baseText) parts.push(baseText);
        if (voiceText) parts.push(`[Voice]: ${voiceText}`);
        if (imagePath) parts.push(`[user attached an image: @${imagePath}]`);
        if (document) parts.push(`[user attached a document "${document.fileName}": @${document.path}]`);
        const fullText = parts.join('\n\n');

        const threadId = `${PREFIX}${msg.key.remoteJid}`;
        log.info('whatsapp in', { jid: msg.key.remoteJid, preview: fullText.slice(0, 80) });
        try {
          await opts.onMessage(threadId, fullText);
        } catch (err) {
          log.error('whatsapp handler error', { jid: msg.key.remoteJid, err });
        }
      }
    });

    return s;
  }

  return {
    async send(threadId: string, text: string, opts?: SendOpts) {
      if (!threadId.startsWith(PREFIX)) {
        throw new Error(`whatsapp channel cannot send to thread ${threadId}`);
      }
      const jid = threadId.slice(PREFIX.length);

      if (opts?.audioPath) {
        const audio = readFileSync(opts.audioPath);
        const mimetype = opts.audioPath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/ogg; codecs=opus';
        const ptt = mimetype.startsWith('audio/ogg'); // only opus is a real voice note
        log.info('whatsapp out (voice)', {
          jid,
          bytes: audio.length,
          preview: text.slice(0, 60),
        });
        await sock.sendMessage(jid, { audio, mimetype, ptt });
        return;
      }

      if (opts?.filePath) {
        const buf = readFileSync(opts.filePath);
        const lower = opts.filePath.toLowerCase();
        const displayName = opts.fileName ?? basename(opts.filePath);
        log.info('whatsapp out (file)', { jid, bytes: buf.length, file: displayName });
        // Pick the WhatsApp message kind from extension. Images and videos
        // render inline; everything else goes as a document attachment.
        if (/\.(jpe?g|png|gif|webp|bmp)$/.test(lower)) {
          await sock.sendMessage(jid, { image: buf, caption: text || undefined });
        } else if (/\.(mp4|mov|webm|m4v)$/.test(lower)) {
          await sock.sendMessage(jid, { video: buf, caption: text || undefined });
        } else {
          const mimetype = mimeFromExtension(lower);
          await sock.sendMessage(jid, {
            document: buf,
            mimetype,
            fileName: displayName,
            caption: text || undefined,
          });
        }
        return;
      }

      log.info('whatsapp out', { jid, preview: text.slice(0, 80) });
      await sock.sendMessage(jid, { text });
    },

    async setTyping(threadId: string) {
      if (!threadId.startsWith(PREFIX)) return;
      const jid = threadId.slice(PREFIX.length);
      try {
        await sock.sendPresenceUpdate('composing', jid);
      } catch (err) {
        // Presence updates fail silently on transient socket issues;
        // typing is a UX nicety, not a correctness signal.
        log.debug('whatsapp setTyping failed', { jid, err });
      }
    },
  };
}

function mimeFromExtension(lower: string): string {
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.md') || lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return 'application/octet-stream';
}
