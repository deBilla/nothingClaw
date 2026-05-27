// MCP tool: synthesize text to speech via local Kokoro, queue as an audio
// outbox row. The host's delivery loop picks it up and sends as a voice
// message on channels that support it (WhatsApp, Telegram).

import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DB_PATH } from '../db/connection.ts';
import { synthesize, KOKORO_OUTPUT_FORMAT } from '../voice.ts';

const OUT_DIR = process.env.MARSCLAW_VOICE_OUT ?? 'data/voice-out';
const THREAD_ID = process.env.MARSCLAW_THREAD_ID ?? '';
const VOICE = process.env.KOKORO_VOICE ?? 'af_heart';

let _db: Database | null = null;
function db(): Database {
  if (!_db) _db = new Database(DB_PATH);
  return _db;
}

export const speakTool = {
  definition: {
    name: 'speak',
    description:
      'Send a SPOKEN reply to the user via Kokoro text-to-speech. Use this when the user sent a voice message (their message starts with "[Voice]:") or asked for a voice reply. Keep spoken replies natural and brief — 1-3 sentences. The text should be plain prose with no markdown, emojis, or code. Your stdout REPLACES nothing — call this in addition to (or instead of) printing text to stdout, depending on whether you also want a text reply.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Plain prose to speak. Keep it short.' },
        voice: { type: 'string', description: `Voice ID (default: ${VOICE}). e.g. af_heart, af_bella, am_adam.` },
      },
      required: ['text'],
    },
  },

  async handler(args: Record<string, unknown>) {
    const text = String(args.text ?? '').trim();
    const voice = String(args.voice ?? VOICE);
    if (!text) {
      return { content: [{ type: 'text', text: 'Error: text is required' }], isError: true };
    }
    if (!THREAD_ID) {
      return { content: [{ type: 'text', text: 'Error: MARSCLAW_THREAD_ID not set' }], isError: true };
    }

    try {
      const audio = await synthesize(text, voice);
      mkdirSync(OUT_DIR, { recursive: true });
      const ext = KOKORO_OUTPUT_FORMAT === 'mp3' ? 'mp3' : 'ogg';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const audioPath = resolve(OUT_DIR, `${id}.${ext}`);
      writeFileSync(audioPath, audio);
      db().query('INSERT INTO outbox (thread_id, text, audio_path) VALUES (?, ?, ?)').run(THREAD_ID, text, audioPath);
      return { content: [{ type: 'text', text: `Queued voice reply (${(audio.length / 1024).toFixed(1)}KB).` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Speech synthesis failed: ${msg}. Is the Kokoro sidecar running? \`bun run voice start\`.` }], isError: true };
    }
  },
};
