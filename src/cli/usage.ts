// `bun run usage` — show recent Anthropic spend.
// Subcommands: today | week | by-thread

import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from '../lib/config.ts';

const USAGE_PATH = process.env.MARSCLAW_USAGE ?? 'data/usage.jsonl';

interface Entry {
  at: string;
  thread: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

function load(): Entry[] {
  if (!existsSync(USAGE_PATH)) return [];
  const out: Entry[] = [];
  for (const line of readFileSync(USAGE_PATH, 'utf-8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as Entry);
    } catch {
      /* skip */
    }
  }
  return out;
}

function sum(entries: Entry[]) {
  let cost = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  for (const e of entries) {
    cost += e.costUsd ?? 0;
    input += e.inputTokens ?? 0;
    output += e.outputTokens ?? 0;
    cacheRead += e.cacheReadTokens ?? 0;
    cacheCreate += e.cacheCreateTokens ?? 0;
  }
  return { cost, input, output, cacheRead, cacheCreate, turns: entries.length };
}

function showSlice(label: string, entries: Entry[]): void {
  const s = sum(entries);
  console.log(`${label}: $${s.cost.toFixed(4)}  (${s.turns} turns)`);
  console.log(`  fresh tokens:    ${s.input} in + ${s.output} out`);
  console.log(`  cache read:      ${s.cacheRead}`);
  console.log(`  cache create:    ${s.cacheCreate}`);
  if (s.cacheRead + s.cacheCreate > 0 && s.input > 0) {
    const hitRate = (s.cacheRead / (s.cacheRead + s.input)) * 100;
    console.log(`  cache hit rate:  ${hitRate.toFixed(1)}%`);
  }
}

const sub = process.argv[3] ?? 'today';
const all = load();
const today = new Date().toISOString().slice(0, 10);

switch (sub) {
  case 'today': {
    const cfg = loadConfig();
    const metered = !!process.env.ANTHROPIC_API_KEY;
    showSlice('today    ', all.filter((e) => e.at?.startsWith(today)));
    if (metered) {
      if (cfg.daily_usd_budget > 0) {
        console.log(`budget   : $${cfg.daily_usd_budget.toFixed(2)}/day (enforced)`);
      } else {
        console.log(`budget   : disabled`);
      }
    } else {
      console.log(`auth     : OAuth subscription (figures are informational; no per-turn billing)`);
    }
    break;
  }
  case 'week': {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    showSlice('last 7d  ', all.filter((e) => +new Date(e.at) >= cutoff));
    break;
  }
  case 'by-thread': {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const last = all.filter((e) => +new Date(e.at) >= cutoff);
    const byThread = new Map<string, Entry[]>();
    for (const e of last) {
      if (!byThread.has(e.thread)) byThread.set(e.thread, []);
      byThread.get(e.thread)!.push(e);
    }
    const rows = [...byThread.entries()]
      .map(([thread, es]) => ({ thread, ...sum(es) }))
      .sort((a, b) => b.cost - a.cost);
    for (const r of rows) {
      console.log(`$${r.cost.toFixed(4)}  ${r.turns} turns  ${r.thread}`);
    }
    break;
  }
  default:
    console.error(`Unknown usage subcommand: ${sub}`);
    console.error('Usage: marsclaw usage [today | week | by-thread]');
    process.exit(1);
}
