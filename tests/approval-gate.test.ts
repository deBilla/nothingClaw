import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  enqueueApproval,
  checkPendingApproval,
  awaitApproval,
  generateNonce,
  APPROVAL_WINDOW_MS,
} from '../src/lib/approval-gate.ts';
import { getStatus } from '../src/db/approvals.ts';

// In-memory DB with just the pending_approvals schema (mirrors migration 0005).
function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE pending_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      tool TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','expired')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

describe('approval nonce', () => {
  it('is unguessable-shaped and prefixed', () => {
    const n = generateNonce();
    expect(n).toMatch(/^ok-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    // No two in a row collide (sanity, not a statistical proof).
    expect(generateNonce()).not.toBe(n);
  });
});

describe('checkPendingApproval', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('approves when the reply contains the nonce and consumes it', () => {
    const { nonce } = enqueueApproval(db, 'telegram:1', 'gmail_send', 'SEND EMAIL\nTo: a@b.com');
    const r = checkPendingApproval(db, 'telegram:1', `sure, ${nonce}`);
    expect(r.consumed).toBe(true);
    expect(r.reply).toContain('Approved');
  });

  it('is case-insensitive on the nonce', () => {
    const { nonce } = enqueueApproval(db, 'telegram:1', 'gmail_send', 'x');
    const r = checkPendingApproval(db, 'telegram:1', nonce.toLowerCase());
    expect(r.consumed).toBe(true);
  });

  it('does NOT consume an unrelated message (flows to the agent)', () => {
    enqueueApproval(db, 'telegram:1', 'gmail_send', 'x');
    const r = checkPendingApproval(db, 'telegram:1', 'what time is it?');
    expect(r.consumed).toBe(false);
  });

  it('only matches approvals for the same thread', () => {
    const { nonce } = enqueueApproval(db, 'telegram:1', 'gmail_send', 'x');
    // Same nonce text but a different thread must not approve.
    const r = checkPendingApproval(db, 'telegram:OTHER', nonce);
    expect(r.consumed).toBe(false);
  });

  it('does not approve an already-expired request', () => {
    // Insert directly with a past expiry.
    const pastSec = Math.floor((Date.now() - 10_000) / 1000);
    db.query(
      "INSERT INTO pending_approvals (thread_id, nonce, tool, summary, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run('telegram:1', 'ok-EXPIRED', 'gmail_send', 'x', pastSec);
    const r = checkPendingApproval(db, 'telegram:1', 'ok-EXPIRED');
    expect(r.consumed).toBe(false);
  });
});

describe('awaitApproval', () => {
  it('returns approved once the row flips', async () => {
    const db = freshDb();
    const { id, nonce } = enqueueApproval(db, 'telegram:1', 'gmail_send', 'x');
    // Approve shortly after starting the wait.
    setTimeout(() => checkPendingApproval(db, 'telegram:1', nonce), 50);
    const verdict = await awaitApproval(db, id);
    expect(verdict).toBe('approved');
    expect(getStatus(db, id)).toBe('approved');
  });

  it('window is comfortably under the 300s agent-turn ceiling', () => {
    expect(APPROVAL_WINDOW_MS).toBeLessThan(300_000);
  });
});
