import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ARCHIVE_DIR = join(tmpdir(), `marsclaw-archive-${process.pid}`);
process.env.MARSCLAW_CONVERSATIONS = ARCHIVE_DIR;

const { archiveConversation } = await import('../src/lib/conversation-archive.ts');
const { runMigrations } = await import('../src/db/migrations.ts');
const { appendMessage } = await import('../src/db/messages.ts');

function freshDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('archiveConversation', () => {
  beforeEach(() => {
    if (existsSync(ARCHIVE_DIR)) rmSync(ARCHIVE_DIR, { recursive: true });
    mkdirSync(ARCHIVE_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(ARCHIVE_DIR)) rmSync(ARCHIVE_DIR, { recursive: true });
  });

  it('writes a markdown file with turns interleaved', () => {
    const db = freshDb();
    appendMessage(db, 'whatsapp:test@lid', 'user', 'hello there');
    appendMessage(db, 'whatsapp:test@lid', 'assistant', 'hi back');
    appendMessage(db, 'whatsapp:test@lid', 'user', 'how are you');

    const path = archiveConversation(db, 'whatsapp:test@lid', { trigger: 'auto', pre_tokens: 10000 });
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);

    const md = readFileSync(path!, 'utf-8');
    expect(md).toContain('# Conversation: whatsapp:test@lid');
    expect(md).toContain('trigger: auto');
    expect(md).toContain('pre=10000');
    expect(md).toContain('— user');
    expect(md).toContain('— assistant');
    expect(md).toContain('hello there');
    expect(md).toContain('hi back');
  });

  it('slugifies the thread id in the filename', () => {
    const db = freshDb();
    appendMessage(db, 'whatsapp:42600000@lid', 'user', 'x');
    archiveConversation(db, 'whatsapp:42600000@lid');
    const files = readdirSync(ARCHIVE_DIR);
    expect(files).toHaveLength(1);
    // colons and @ should be replaced with underscores
    expect(files[0]).not.toContain(':');
    expect(files[0]).not.toContain('@');
    expect(files[0]).toMatch(/^whatsapp_42600000_lid-.*\.md$/);
  });

  it('writes an empty-marker file when there are no turns', () => {
    const db = freshDb();
    const path = archiveConversation(db, 'whatsapp:nobody@lid');
    expect(path).not.toBeNull();
    const md = readFileSync(path!, 'utf-8');
    expect(md).toContain('_(no recorded turns)_');
  });
});
