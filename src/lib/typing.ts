// Typing-indicator refresh.
//
// Most messaging platforms expire a "typing…" signal after 5–10s, so a
// one-shot call on inbound goes stale long before the agent finishes
// thinking. This module keeps it alive by re-firing on a short interval —
// gated on the agent's heartbeat freshness, so we stop signalling as soon
// as the session is idle (not just when we finish writing a reply).
//
// After delivering a user-facing message, the refresh pauses for a short
// window so the client's typing indicator visually clears.

import { statSync } from 'node:fs';
import { log } from './log.ts';

const HEARTBEAT_PATH = process.env.MARSCLAW_HEARTBEAT ?? 'data/heartbeat';
const REFRESH_MS = 4000;
// Initial grace period: fire typing unconditionally for this long after
// startTypingRefresh — covers the first few seconds before the SDK has
// emitted any heartbeat-touching message.
const GRACE_MS = 8000;
// After the grace window, the heartbeat must be touched within this many
// ms of "now" to count as "agent is actively working". The SDK touches
// it on every inbound message; idle gaps push this beyond the threshold.
const HEARTBEAT_FRESH_MS = 6000;
// Pause window after a user-facing message is delivered, so the client's
// typing indicator has time to visually clear.
const POST_DELIVERY_PAUSE_MS = 10000;

interface SetTyping {
  setTyping?(threadId: string): Promise<void>;
}

interface Target {
  threadId: string;
  setTyping: (id: string) => Promise<void>;
  timer: ReturnType<typeof setInterval>;
  startedAt: number;
  pausedUntil: number; // epoch ms; 0 = not paused
}

const active = new Map<string, Target>();

function heartbeatFresh(now: number): boolean {
  try {
    const st = statSync(HEARTBEAT_PATH);
    return now - st.mtimeMs <= HEARTBEAT_FRESH_MS;
  } catch (err) {
    void err;
    // No heartbeat yet — treat as fresh during the grace window, stale after.
    return false;
  }
}

/**
 * Begin refreshing typing for a thread. Idempotent: calling again on the
 * same threadId resets the grace window. Stops automatically when
 * `stopTypingRefresh` is called.
 */
export function startTypingRefresh(threadId: string, router: SetTyping): void {
  // No-op if the channel doesn't support typing (Slack DMs, etc.).
  if (!router.setTyping) return;
  const setTyping = router.setTyping.bind(router);

  // Reset if already active.
  stopTypingRefresh(threadId);

  // Fire immediately for instant feedback.
  void setTyping(threadId).catch((err) => log.debug('initial setTyping failed', { err }));

  const startedAt = Date.now();
  const timer = setInterval(() => {
    const t = active.get(threadId);
    if (!t) return;
    const now = Date.now();
    if (now < t.pausedUntil) return; // inside post-delivery pause
    const withinGrace = now - t.startedAt < GRACE_MS;
    if (!withinGrace && !heartbeatFresh(now)) {
      // Agent went idle — stop signalling. The next inbound message will
      // re-start the refresh.
      stopTypingRefresh(threadId);
      return;
    }
    void t.setTyping(threadId).catch((err) => log.debug('setTyping refresh failed', { err }));
  }, REFRESH_MS);

  active.set(threadId, {
    threadId,
    setTyping,
    timer,
    startedAt,
    pausedUntil: 0,
  });
}

export function stopTypingRefresh(threadId: string): void {
  const t = active.get(threadId);
  if (!t) return;
  clearInterval(t.timer);
  active.delete(threadId);
}

/**
 * Briefly pause the refresh for a thread (or all threads) after a user-facing
 * message lands. Doesn't tear down the timer — ticks during the pause just
 * skip the setTyping call.
 */
export function pauseTypingAfterDelivery(threadId: string): void {
  const t = active.get(threadId);
  if (!t) return;
  t.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
}

export function shutdownTyping(): void {
  for (const t of active.values()) clearInterval(t.timer);
  active.clear();
}
