// Startup circuit breaker. Persists an attempt counter on disk and forces
// an exponential back-off when the bot is crash-looping (consecutive starts
// within 1h). Stops a runaway from hammering the WhatsApp / Anthropic /
// Telegram APIs and getting the account rate-limited or banned.
//
// State machine:
//   - On boot: read prior attempt. If older than RESET_WINDOW_MS, reset to 1.
//     Otherwise increment.
//   - Sleep `BACKOFF_SCHEDULE_S[min(attempt-1, last)]` seconds before
//     proceeding.
//   - On clean shutdown: `resetCircuitBreaker()` wipes the file so the
//     next normal start is fast.

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { writeAtomic } from './atomic.ts';
import { log } from './log.ts';

const CB_PATH = process.env.MARSCLAW_CIRCUIT_BREAKER ?? 'data/circuit-breaker.json';
const RESET_WINDOW_MS = 60 * 60 * 1000; // 1 hour
// Index = number of consecutive crashes (0 = clean start, attempt 1).
// 6+ crashes capped at 15min.
const BACKOFF_SCHEDULE_S = [0, 0, 10, 30, 120, 300, 900];

interface CircuitBreakerState {
  attempt: number;
  timestamp: string;
}

function read(): CircuitBreakerState | null {
  if (!existsSync(CB_PATH)) return null;
  try {
    const raw = readFileSync(CB_PATH, 'utf-8');
    return JSON.parse(raw) as CircuitBreakerState;
  } catch (err) {
    // Corrupt file — treat as no prior state. Atomic writes should prevent
    // this in practice; only happens if the user mangled the file.
    log.debug('circuit-breaker file unreadable — resetting', { err });
    return null;
  }
}

function getDelay(attempt: number): number {
  const idx = Math.min(attempt - 1, BACKOFF_SCHEDULE_S.length - 1);
  return BACKOFF_SCHEDULE_S[idx];
}

export function resetCircuitBreaker(): void {
  if (!existsSync(CB_PATH)) return;
  try {
    unlinkSync(CB_PATH);
    log.info('circuit breaker reset on clean shutdown');
  } catch (err) {
    log.debug('circuit-breaker unlink failed — already gone or no permission', { err });
  }
}

export async function enforceStartupBackoff(): Promise<void> {
  const now = new Date();
  const prev = read();

  let attempt: number;
  if (!prev) {
    attempt = 1;
  } else {
    const elapsedMs = now.getTime() - new Date(prev.timestamp).getTime();
    if (elapsedMs < RESET_WINDOW_MS) {
      attempt = prev.attempt + 1;
      log.warn('previous startup was not a clean shutdown', {
        previousAttempt: prev.attempt,
        previousTimestamp: prev.timestamp,
        elapsedSec: Math.round(elapsedMs / 1000),
      });
    } else {
      attempt = 1;
      log.info('circuit breaker reset — last startup was over 1h ago', {
        previousAttempt: prev.attempt,
        previousTimestamp: prev.timestamp,
      });
    }
  }

  writeAtomic(CB_PATH, JSON.stringify({ attempt, timestamp: now.toISOString() }, null, 2) + '\n');

  const delaySec = getDelay(attempt);
  if (delaySec > 0) {
    const resumeAt = new Date(now.getTime() + delaySec * 1000).toISOString();
    log.warn('circuit breaker: delaying startup due to repeated crashes', {
      attempt,
      delaySec,
      resumeAt,
    });
    await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
    log.info('circuit breaker: backoff complete', { attempt });
  }
}
