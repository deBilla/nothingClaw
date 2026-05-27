// Dump a thread's recent conversation history to `conversations/<thread>-<ts>.md`.
//
// Called when the SDK emits a `compact_boundary` system message — i.e. the
// model just compressed its context and the "human-readable" version of the
// pre-compact turns is about to become lossy. We snapshot before the loss.
//
// Schema (one heading per turn):
//   # Conversation: whatsapp:42600000@lid
//   _Archived 2026-05-25T15:30:00Z (trigger: auto, pre=156000 → post=24000 tokens)_
//
//   ## 2026-05-25T15:28:01Z — user
//   text…
//
//   ## 2026-05-25T15:28:04Z — assistant
//   text…

import type { Database } from 'bun:sqlite';
import { writeAtomic } from './atomic.ts';
import { log } from './log.ts';

const ARCHIVE_DIR = process.env.MARSCLAW_CONVERSATIONS ?? 'conversations';
// Max turns to dump per archive. The DB has everything; this just bounds the
// file size. 200 turns ≈ 1-2k lines of markdown, plenty for any human review.
const MAX_TURNS = 200;

interface CompactMeta {
  trigger?: string;
  pre_tokens?: number;
  post_tokens?: number;
  duration_ms?: number;
}

function slugifyThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function tsForFile(d: Date): string {
  // 2026-05-25T15-30-00Z — colons are reserved on some filesystems.
  return d.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
}

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  created_at: number;
}

function renderMarkdown(threadId: string, meta: CompactMeta, turns: Turn[]): string {
  const now = new Date().toISOString();
  const lines: string[] = [];
  lines.push(`# Conversation: ${threadId}`);
  const metaParts: string[] = [];
  if (meta.trigger) metaParts.push(`trigger: ${meta.trigger}`);
  if (meta.pre_tokens !== undefined) {
    metaParts.push(
      `pre=${meta.pre_tokens}${meta.post_tokens !== undefined ? ` → post=${meta.post_tokens}` : ''} tokens`,
    );
  }
  if (meta.duration_ms !== undefined) metaParts.push(`compact_ms=${meta.duration_ms}`);
  lines.push(`_Archived ${now}${metaParts.length ? ` (${metaParts.join(', ')})` : ''}_`);
  lines.push('');

  if (turns.length === 0) {
    lines.push('_(no recorded turns)_');
    return lines.join('\n') + '\n';
  }

  for (const t of turns) {
    const when = new Date(t.created_at * 1000).toISOString();
    lines.push(`## ${when} — ${t.role}`);
    lines.push('');
    lines.push(t.text);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

export function archiveConversation(
  db: Database,
  threadId: string,
  meta: CompactMeta = {},
): string | null {
  try {
    const rows = db
      .query(
        'SELECT role, text, created_at FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(threadId, MAX_TURNS) as Turn[];
    const turns = rows.reverse();
    const md = renderMarkdown(threadId, meta, turns);
    const filename = `${slugifyThreadId(threadId)}-${tsForFile(new Date())}.md`;
    const path = `${ARCHIVE_DIR}/${filename}`;
    writeAtomic(path, md);
    log.info('conversation archived', {
      thread: threadId,
      path,
      turns: turns.length,
      trigger: meta.trigger,
    });
    return path;
  } catch (err) {
    // Archive failure shouldn't kill the bot — log and continue. The DB
    // still has the messages; user can re-dump later.
    log.warn('conversation archive failed', { thread: threadId, err });
    return null;
  }
}
