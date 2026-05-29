// pending_approvals access. Two processes touch this table:
//   - the MCP child (mutation gate) creates a row and polls its status
//   - the main process (approval interceptor) flips status to 'approved'
// They coordinate only through these rows in the shared SQLite file.

import type { Database } from 'bun:sqlite';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PendingApproval {
  id: number;
  thread_id: string;
  nonce: string;
  tool: string;
  summary: string;
  status: ApprovalStatus;
  created_at: number;
  expires_at: number;
}

export function createApproval(
  db: Database,
  row: { thread_id: string; nonce: string; tool: string; summary: string; expires_at: number },
): number {
  const res = db
    .query(
      `INSERT INTO pending_approvals (thread_id, nonce, tool, summary, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(row.thread_id, row.nonce, row.tool, row.summary, row.expires_at);
  return Number(res.lastInsertRowid);
}

/** Current status, lazily expiring a row whose deadline has passed. */
export function getStatus(db: Database, id: number, now: number = Date.now()): ApprovalStatus | null {
  const row = db.query('SELECT status, expires_at FROM pending_approvals WHERE id = ?').get(id) as
    | { status: ApprovalStatus; expires_at: number }
    | null;
  if (!row) return null;
  if (row.status === 'pending' && now > row.expires_at * 1000) {
    db.query("UPDATE pending_approvals SET status = 'expired' WHERE id = ? AND status = 'pending'").run(id);
    return 'expired';
  }
  return row.status;
}

/** Pending, non-expired approvals for a thread (newest first). */
export function listPending(db: Database, threadId: string, now: number = Date.now()): PendingApproval[] {
  const rows = db
    .query(
      `SELECT id, thread_id, nonce, tool, summary, status, created_at, expires_at
       FROM pending_approvals
       WHERE thread_id = ? AND status = 'pending'
       ORDER BY id DESC`,
    )
    .all(threadId) as PendingApproval[];
  return rows.filter((r) => now <= r.expires_at * 1000);
}

/** Mark approved only if still pending (avoids racing a just-expired row). */
export function approve(db: Database, id: number): boolean {
  const res = db
    .query("UPDATE pending_approvals SET status = 'approved' WHERE id = ? AND status = 'pending'")
    .run(id);
  return res.changes > 0;
}

export function deny(db: Database, id: number): void {
  db.query("UPDATE pending_approvals SET status = 'denied' WHERE id = ? AND status = 'pending'").run(id);
}
