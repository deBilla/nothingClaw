// Anthropic spend tracking.
//
// Appends one JSONL line per turn to `data/usage.jsonl`. Each line records
// timestamp, threadId, input/output tokens, total_cost_usd, duration_ms.
// Before each turn we sum today's lines; if today's spend exceeds
// `config.daily_usd_budget`, we refuse with a user-facing message until
// midnight (local).
//
// Why JSONL and not a DB table? The data is append-only and we want to
// `tail -F` / `jq` it for ad-hoc inspection. SQLite would be overkill.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from './log.ts';

const USAGE_PATH = process.env.MARSCLAW_USAGE ?? 'data/usage.jsonl';

export interface UsageEntry {
  at: string; // ISO timestamp
  thread: string;
  provider: 'claude' | 'gemini';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  costUsd: number;
  durationMs: number;
}

export function recordUsage(entry: UsageEntry): void {
  try {
    mkdirSync(dirname(USAGE_PATH), { recursive: true });
    appendFileSync(USAGE_PATH, JSON.stringify(entry) + '\n');
  } catch (err) {
    // Logging usage shouldn't ever break the reply path — just warn.
    log.warn('failed to append usage entry', { err });
  }
}

/** Sum of `costUsd` for all entries whose `at` falls on the local-tz day `dayIso`
 *  (`YYYY-MM-DD`). Linear scan; the file stays bounded by the daily-budget UX. */
export function todaySpendUsd(dayIso: string = todayIso()): number {
  if (!existsSync(USAGE_PATH)) return 0;
  let total = 0;
  try {
    const raw = readFileSync(USAGE_PATH, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as UsageEntry;
        if (typeof e.at === 'string' && e.at.startsWith(dayIso) && typeof e.costUsd === 'number') {
          total += e.costUsd;
        }
      } catch {
        /* skip malformed line */
      }
    }
  } catch (err) {
    log.warn('failed to read usage.jsonl', { err });
  }
  return total;
}

function todayIso(): string {
  // YYYY-MM-DD using the configured timezone is overkill for personal scale;
  // process locale is fine.
  return new Date().toISOString().slice(0, 10);
}

export function isOverBudget(budgetUsd: number, dayIso: string = todayIso()): boolean {
  if (budgetUsd <= 0) return false;
  return todaySpendUsd(dayIso) >= budgetUsd;
}
