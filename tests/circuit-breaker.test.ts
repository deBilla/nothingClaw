import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_CB_PATH = join(tmpdir(), `marsclaw-cb-${process.pid}.json`);
process.env.MARSCLAW_CIRCUIT_BREAKER = TEST_CB_PATH;

// Import AFTER env is set so the module-level const picks it up.
const { enforceStartupBackoff, resetCircuitBreaker } = await import('../src/lib/circuit-breaker.ts');

function read(): { attempt: number; timestamp: string } {
  return JSON.parse(readFileSync(TEST_CB_PATH, 'utf-8'));
}

describe('circuit breaker', () => {
  beforeEach(() => {
    if (existsSync(TEST_CB_PATH)) unlinkSync(TEST_CB_PATH);
  });
  afterEach(() => {
    if (existsSync(TEST_CB_PATH)) unlinkSync(TEST_CB_PATH);
  });

  it('first run starts at attempt 1 with no delay', async () => {
    const t0 = Date.now();
    await enforceStartupBackoff();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(read().attempt).toBe(1);
  });

  it('second run within 1h increments to attempt 2 (still no delay)', async () => {
    await enforceStartupBackoff();
    const t0 = Date.now();
    await enforceStartupBackoff();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(read().attempt).toBe(2);
  });

  it('reset wipes the file', async () => {
    await enforceStartupBackoff();
    expect(existsSync(TEST_CB_PATH)).toBe(true);
    resetCircuitBreaker();
    expect(existsSync(TEST_CB_PATH)).toBe(false);
  });

  it('an old timestamp (>1h) resets the counter to 1', async () => {
    // Write a fake state with a very old timestamp.
    writeFileSync(
      TEST_CB_PATH,
      JSON.stringify({
        attempt: 6,
        timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      }),
    );
    await enforceStartupBackoff();
    expect(read().attempt).toBe(1);
  });
});
