// Chat-native mutation approval (NemoClaw-style operator approval, adapted for
// a bot whose only operator interface is a chat app).
//
// The security property we preserve from the rejected "tap yes in chat" design:
//   1. The approval prompt is composed by THIS trusted code from the tool's
//      structured parameters — never free-text authored by the (possibly
//      hijacked) model. The human judges "SEND EMAIL to attacker@evil.com",
//      a faithful structured rendering, not a persuasive sentence.
//   2. The approval token (nonce) is generated here with crypto randomness —
//      the agent cannot predict or produce it.
//   3. The operator's reply is intercepted in the main process BEFORE the agent
//      loop (see src/index.ts onMessage), so the agent never sees it and can't
//      forge or read it.
//
// Two halves live here:
//   - enqueueApproval / awaitApproval: run in the MCP child (the mutation gate)
//   - checkPendingApproval: runs in the main process (the channel dispatcher)

import { randomBytes } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { createApproval, getStatus, listPending, approve } from '../db/approvals.ts';

// No-typo alphabet (omits 0/O/1/I/L) — operators type this on a phone.
const NONCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateNonce(): string {
  const bytes = randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += NONCE_ALPHABET[bytes[i]! % NONCE_ALPHABET.length];
  return `ok-${s}`;
}

// How long the operator has to approve, and how the MCP-side poll behaves.
// The window stays well under the 300s agent-turn ceiling so a pending
// approval can't outlive the turn that's blocked waiting on it.
export const APPROVAL_WINDOW_MS = 120_000;
const POLL_INTERVAL_MS = 1000;

/** Render the broker-authored operator prompt. summary is multi-line, e.g.
 *  "SEND EMAIL\nTo: a@b.com\nSubject: Hi". */
export function renderApprovalPrompt(summary: string, nonce: string): string {
  const mins = Math.round(APPROVAL_WINDOW_MS / 60_000);
  return (
    `⚠️ Approval needed — marsClaw wants to:\n\n${summary}\n\n` +
    `Reply \`${nonce}\` within ${mins} min to allow. Ignore (or say "stop") to deny.`
  );
}

export interface EnqueuedApproval {
  id: number;
  nonce: string;
  prompt: string;
}

/** MCP-child side: record a pending approval and return the operator prompt to
 *  deliver. Does NOT send anything itself — the caller writes the prompt to the
 *  outbox so the main process delivers it. */
export function enqueueApproval(
  db: Database,
  threadId: string,
  tool: string,
  summary: string,
  now: number = Date.now(),
): EnqueuedApproval {
  const nonce = generateNonce();
  const id = createApproval(db, {
    thread_id: threadId,
    nonce,
    tool,
    summary,
    expires_at: Math.floor((now + APPROVAL_WINDOW_MS) / 1000),
  });
  return { id, nonce, prompt: renderApprovalPrompt(summary, nonce) };
}

/** MCP-child side: block until the approval row is resolved or the window
 *  lapses. Returns the terminal status. */
export async function awaitApproval(db: Database, id: number): Promise<'approved' | 'denied' | 'expired'> {
  const deadline = Date.now() + APPROVAL_WINDOW_MS + 2000;
  while (Date.now() < deadline) {
    const status = getStatus(db, id);
    if (status === 'approved') return 'approved';
    if (status === 'denied') return 'denied';
    if (status === 'expired' || status === null) return 'expired';
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return 'expired';
}

export interface ApprovalCheck {
  consumed: boolean;
  reply?: string;
}

/** Main-process side: does this inbound text approve a pending action for the
 *  thread? If so, flip the row and return a confirmation to send back. Called
 *  from the channel dispatcher BEFORE the message reaches the agent loop, so
 *  the agent never sees the nonce. */
export function checkPendingApproval(db: Database, threadId: string, text: string): ApprovalCheck {
  const pending = listPending(db, threadId);
  if (pending.length === 0) return { consumed: false };
  const hay = text.trim().toLowerCase();
  for (const row of pending) {
    if (hay.includes(row.nonce.toLowerCase())) {
      const ok = approve(db, row.id);
      return {
        consumed: true,
        reply: ok ? '✅ Approved — proceeding now.' : '⌛ That approval already expired. Ask me to try again.',
      };
    }
  }
  return { consumed: false };
}
