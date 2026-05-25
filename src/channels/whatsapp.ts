// WhatsApp adapter via Baileys (unofficial, QR-scan auth).
//
// First run: prints a QR code to terminal. Scan it with WhatsApp on your phone
// (Linked devices → Link a device). Auth state is saved to ./data/whatsapp-auth
// for subsequent runs.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { transcribe, whisperHealthy } from '../voice.ts';

const PREFIX = 'whatsapp:';
const AUTH_DIR = process.env.NOTHINGCLAW_WHATSAPP_AUTH ?? 'data/whatsapp-auth';
const MEDIA_DIR = process.env.NOTHINGCLAW_WHATSAPP_MEDIA ?? 'data/whatsapp-media';
const VERBOSE = process.env.NOTHINGCLAW_WHATSAPP_VERBOSE === '1';
const VOICE_ENABLED = process.env.NOTHINGCLAW_VOICE === '1';

const logger = pino({ level: VERBOSE ? 'info' : 'silent' });

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
    console.error('[whatsapp] audio download failed:', err instanceof Error ? err.message : err);
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
    console.error('[whatsapp] image download failed:', err instanceof Error ? err.message : err);
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
    const original = (doc.fileName ?? '').replace(/[^a-zA-Z0-9._-]/g, '_');
    const mime = doc.mimetype ?? 'application/octet-stream';
    const mimeExt = (mime.split('/').pop() ?? 'bin').split(';')[0];
    const ext = original.includes('.') ? original.split('.').pop()! : mimeExt;
    const filePath = resolve(MEDIA_DIR, `${id}.${ext}`);
    writeFileSync(filePath, buffer as Buffer);
    return { path: filePath, fileName: original || `document.${ext}` };
  } catch (err) {
    console.error('[whatsapp] document download failed:', err instanceof Error ? err.message : err);
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

export async function createWhatsappChannel(opts: ChannelInit): Promise<Channel> {
  mkdirSync(AUTH_DIR, { recursive: true });
  let sock: WASocket = await connect(opts);
  let consecutiveFailures = 0;

  async function connect(opts: ChannelInit): Promise<WASocket> {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const s = makeWASocket({ auth: state, logger });

    s.ev.on('creds.update', saveCreds);

    s.ev.on('connection.update', (u) => {
      if (u.qr) {
        console.log('\n[whatsapp] scan this QR with your phone (Settings → Linked devices → Link a device):\n');
        qrcode.generate(u.qr, { small: true });
      }
      if (u.connection === 'open') {
        consecutiveFailures = 0;
        console.log('[whatsapp] connected');
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        consecutiveFailures++;

        if (loggedOut) {
          console.log('[whatsapp] logged out — delete data/whatsapp-auth/ and re-run to re-link');
          return;
        }

        if (consecutiveFailures >= 5) {
          console.error('[whatsapp] giving up after 5 failed connection attempts.');
          console.error('  - too many linked devices on your account (max 4)');
          console.error('  - WhatsApp blocked the link from this IP / region');
          console.error(`  - last status code: ${code}`);
          return;
        }

        console.log(`[whatsapp] disconnected (code=${code}, reconnecting #${consecutiveFailures})`);
        setTimeout(async () => {
          sock = await connect(opts);
        }, 2000);
      }
    });

    s.ev.on('messages.upsert', async ({ messages, type }) => {
      // 'notify' = live new message. 'append' = history sync after pairing —
      // do NOT auto-reply to those, they're things the user already sent/received.
      if (type !== 'notify') {
        if (VERBOSE) console.log(`[whatsapp] ignored ${messages.length} ${type} message(s)`);
        return;
      }
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.key.remoteJid) continue;
        // skip groups by default — only DMs (1:1 chats end in @s.whatsapp.net)
        if (msg.key.remoteJid.endsWith('@g.us')) continue;
        // skip status broadcasts
        if (msg.key.remoteJid === 'status@broadcast') continue;

        const baseText = extractText(msg.message);
        const imagePath = await tryDownloadImage(msg);
        const audioPath = await tryDownloadAudio(msg);
        const document = await tryDownloadDocument(msg);

        // Transcribe audio if voice support is enabled + whisper sidecar is up.
        let voiceText = '';
        if (audioPath && VOICE_ENABLED) {
          try {
            const t0 = Date.now();
            voiceText = await transcribe(audioPath);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`[whatsapp] transcribed ${audioPath} in ${elapsed}s: ${voiceText.slice(0, 80)}${voiceText.length > 80 ? '…' : ''}`);
          } catch (err) {
            console.error('[whatsapp] transcribe failed:', err instanceof Error ? err.message : err);
            voiceText = '(voice message — transcription failed; ask the user to type)';
          }
        } else if (audioPath) {
          console.log(`[whatsapp] received audio but NOTHINGCLAW_VOICE!=1; skipping transcription`);
        }

        if (!baseText && !imagePath && !voiceText && !document) {
          const kind = msg.message ? Object.keys(msg.message)[0] : 'empty';
          console.log(`[whatsapp] skipped non-text (${kind}) from ${msg.key.remoteJid}`);
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
        const preview = fullText.slice(0, 80);
        console.log(`[whatsapp] in  ${msg.key.remoteJid}: ${preview}${fullText.length > 80 ? '…' : ''}`);
        try {
          await opts.onMessage(threadId, fullText);
        } catch (err) {
          console.error('[whatsapp] handler error', err);
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
        console.log(`[whatsapp] out (voice, ${(audio.length/1024).toFixed(1)}KB) ${jid}: ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`);
        await sock.sendMessage(jid, { audio, mimetype, ptt });
        return;
      }

      console.log(`[whatsapp] out ${jid}: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`);
      await sock.sendMessage(jid, { text });
    },
  };
}
