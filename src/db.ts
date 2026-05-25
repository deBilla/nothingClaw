import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DB_PATH = process.env.NOTHINGCLAW_DB ?? 'data/nothingclaw.db';

export interface HistoryRow {
  role: 'user' | 'assistant';
  text: string;
}

export interface OutboxRow {
  id: number;
  thread_id: string;
  text: string;
  audio_path: string | null;
}

export function initDb(): Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages(thread_id, id);

    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      text TEXT NOT NULL,
      audio_path TEXT,
      delivered_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(delivered_at, id);

    CREATE TABLE IF NOT EXISTS sessions (
      thread_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  // Migration: add audio_path column for pre-Stage-2 databases that don't have it.
  const cols = db.query('PRAGMA table_info(outbox)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'audio_path')) {
    db.exec('ALTER TABLE outbox ADD COLUMN audio_path TEXT');
  }
  return db;
}

export function loadHistory(db: Database, threadId: string, limit = 20): HistoryRow[] {
  const rows = db
    .query('SELECT role, text FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?')
    .all(threadId, limit) as HistoryRow[];
  return rows.reverse();
}

export function appendMessage(db: Database, threadId: string, role: 'user' | 'assistant', text: string): void {
  db.query('INSERT INTO messages (thread_id, role, text) VALUES (?, ?, ?)').run(threadId, role, text);
}

export function takePendingOutbox(db: Database, limit = 20): OutboxRow[] {
  return db
    .query('SELECT id, thread_id, text, audio_path FROM outbox WHERE delivered_at IS NULL ORDER BY id LIMIT ?')
    .all(limit) as OutboxRow[];
}

export function markOutboxDelivered(db: Database, id: number): void {
  db.query('UPDATE outbox SET delivered_at = unixepoch() WHERE id = ?').run(id);
}

export function getThreadSession(db: Database, threadId: string, provider: string): string | null {
  const row = db
    .query('SELECT session_id FROM sessions WHERE thread_id = ? AND provider = ?')
    .get(threadId, provider) as { session_id: string } | null;
  return row?.session_id ?? null;
}

export function setThreadSession(db: Database, threadId: string, provider: string, sessionId: string): void {
  db.query(
    `INSERT INTO sessions (thread_id, provider, session_id, updated_at) VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(thread_id) DO UPDATE SET provider = excluded.provider, session_id = excluded.session_id, updated_at = unixepoch()`,
  ).run(threadId, provider, sessionId);
}

export function clearThreadSession(db: Database, threadId: string): void {
  db.query('DELETE FROM sessions WHERE thread_id = ?').run(threadId);
}
