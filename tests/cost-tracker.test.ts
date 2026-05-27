import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const USAGE_DIR = join(tmpdir(), `marsclaw-usage-${process.pid}`);
const USAGE_PATH = join(USAGE_DIR, 'usage.jsonl');
process.env.MARSCLAW_USAGE = USAGE_PATH;

const { recordUsage, todaySpendUsd, isOverBudget } = await import('../src/lib/cost-tracker.ts');

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('cost-tracker', () => {
  beforeEach(() => {
    if (existsSync(USAGE_DIR)) rmSync(USAGE_DIR, { recursive: true });
    mkdirSync(USAGE_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(USAGE_DIR)) rmSync(USAGE_DIR, { recursive: true });
  });

  it('records and sums today spend', () => {
    expect(todaySpendUsd()).toBe(0);
    recordUsage({
      at: new Date().toISOString(),
      thread: 'whatsapp:test',
      provider: 'claude',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.012,
      durationMs: 800,
    });
    recordUsage({
      at: new Date().toISOString(),
      thread: 'whatsapp:test',
      provider: 'claude',
      inputTokens: 200,
      outputTokens: 80,
      costUsd: 0.025,
      durationMs: 1200,
    });
    expect(todaySpendUsd()).toBeCloseTo(0.037, 5);
  });

  it('isOverBudget returns false when under', () => {
    recordUsage({
      at: new Date().toISOString(),
      thread: 't',
      provider: 'claude',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.5,
      durationMs: 100,
    });
    expect(isOverBudget(5)).toBe(false);
  });

  it('isOverBudget returns true when crossed', () => {
    recordUsage({
      at: new Date().toISOString(),
      thread: 't',
      provider: 'claude',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 6.0,
      durationMs: 100,
    });
    expect(isOverBudget(5)).toBe(true);
  });

  it('budget <= 0 means unlimited', () => {
    recordUsage({
      at: new Date().toISOString(),
      thread: 't',
      provider: 'claude',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 1000,
      durationMs: 0,
    });
    expect(isOverBudget(0)).toBe(false);
  });

  it('entries from other days are excluded', () => {
    recordUsage({
      at: '2024-01-01T12:00:00.000Z',
      thread: 't',
      provider: 'claude',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 99,
      durationMs: 0,
    });
    expect(todaySpendUsd(today())).toBe(0);
  });

  it('malformed lines are skipped', () => {
    writeFileSync(USAGE_PATH, 'not json\n{"costUsd":0.01,"at":"' + today() + 'T00:00:00Z"}\nalso bad\n');
    expect(todaySpendUsd()).toBeCloseTo(0.01, 5);
  });
});
