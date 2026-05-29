import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/db/migrations.ts';

function appliedVersions(db: Database): number[] {
  const rows = db.query('SELECT version FROM schema_migrations ORDER BY version').all() as {
    version: number;
  }[];
  return rows.map((r) => r.version);
}

function tableExists(db: Database, name: string): boolean {
  return db.query('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('table', name) !== null;
}

describe('migrations', () => {
  it('fresh database applies every migration in order', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
    expect(tableExists(db, 'messages')).toBe(true);
    expect(tableExists(db, 'outbox')).toBe(true);
    expect(tableExists(db, 'sessions')).toBe(true);
    const cols = db.query('PRAGMA table_info(outbox)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('attempts');
    expect(cols.map((c) => c.name)).toContain('failed_at');
  });

  it('is idempotent — re-running does not re-apply', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    runMigrations(db);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
  });

  it('bootstrap-stamps pre-existing schema', () => {
    const db = new Database(':memory:');
    // Simulate pre-migration schema: messages + outbox + sessions, no
    // schema_migrations table. audio_path is already there (matches
    // the inline pre-existing migration).
    db.exec(`
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, text TEXT NOT NULL, audio_path TEXT, delivered_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE sessions (thread_id TEXT PRIMARY KEY, provider TEXT NOT NULL, session_id TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
    `);
    runMigrations(db);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
    const cols = db.query('PRAGMA table_info(outbox)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('attempts');
  });

  it('bootstrap backfills stale undelivered rows with failed_at', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, text TEXT NOT NULL, audio_path TEXT, delivered_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE sessions (thread_id TEXT PRIMARY KEY, provider TEXT NOT NULL, session_id TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
    `);
    // Seed a >24h-old undelivered row and a fresh one.
    db.query('INSERT INTO outbox (thread_id, text, created_at) VALUES (?, ?, unixepoch() - 100000)').run(
      'whatsapp:test',
      'stale',
    );
    db.query('INSERT INTO outbox (thread_id, text) VALUES (?, ?)').run('whatsapp:test', 'fresh');
    runMigrations(db);

    const rows = db.query('SELECT text, failed_at, last_error FROM outbox ORDER BY id').all() as {
      text: string;
      failed_at: number | null;
      last_error: string | null;
    }[];
    expect(rows[0].text).toBe('stale');
    expect(rows[0].failed_at).not.toBeNull();
    expect(rows[0].last_error).toBe('migrated-stale');
    expect(rows[1].text).toBe('fresh');
    expect(rows[1].failed_at).toBeNull();
  });
});
