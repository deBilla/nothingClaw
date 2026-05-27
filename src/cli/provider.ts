// Switch the active agent provider without rerunning full setup.
//
// Usage:
//   marsclaw provider             — interactive picker
//   marsclaw provider gemini      — switch directly
//   marsclaw provider claude

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { PROVIDERS } from '../providers/registry.ts';
import type { Provider, ProviderName } from '../providers/types.ts';
import { printBanner } from './branding.ts';

const rl = createInterface({ input: stdin, output: stdout });

const bold  = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const ok    = (s: string) => console.log(`\x1b[32m✓\x1b[0m ${s}`);
const info  = (s: string) => console.log(`  ${s}`);
const warn  = (s: string) => console.log(`\x1b[33m!\x1b[0m ${s}`);

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf-8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function readEnvProvider(): ProviderName {
  if (!existsSync('.env')) return 'gemini';
  for (const line of readFileSync('.env', 'utf-8').split('\n')) {
    const m = line.match(/^\s*AGENT_PROVIDER\s*=\s*(\S+)/);
    if (m && (m[1] === 'gemini' || m[1] === 'claude')) return m[1];
  }
  return 'gemini';
}

function writeEnvProvider(name: ProviderName): void {
  const existing = existsSync('.env') ? readFileSync('.env', 'utf-8') : '';
  const lines = existing.split('\n');
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*AGENT_PROVIDER\s*=/.test(lines[i])) {
      lines[i] = `AGENT_PROVIDER=${name}`;
      found = true;
      break;
    }
  }
  if (!found) lines.unshift(`AGENT_PROVIDER=${name}`);
  writeFileSync('.env', lines.join('\n').replace(/\n+$/, '') + '\n');
}

async function pickProviderInteractive(): Promise<Provider> {
  info('  [g] Gemini CLI');
  info('  [c] Claude Code');
  while (true) {
    const c = (await rl.question('Choice (g/c): ')).trim().toLowerCase();
    if (c === 'g' || c === 'gemini') return PROVIDERS.gemini;
    if (c === 'c' || c === 'claude') return PROVIDERS.claude;
    warn('Please enter g or c.');
  }
}

async function main(): Promise<void> {
  printBanner('switch provider');

  const current = readEnvProvider();
  info(`current provider: ${current}`);

  let target: Provider;
  const arg = process.argv[3]?.toLowerCase();
  if (arg === 'gemini' || arg === 'claude') {
    target = PROVIDERS[arg];
  } else if (arg) {
    warn(`Unknown provider: ${arg}. Use "gemini" or "claude".`);
    rl.close();
    process.exit(1);
  } else {
    bold('Pick a provider');
    target = await pickProviderInteractive();
  }

  if (target.name === current) {
    ok(`Already using ${current}. Nothing to change.`);
    rl.close();
    return;
  }

  // Ensure installed
  if (!which(target.bin)) {
    info(`Installing ${target.npmPackage} (not currently on PATH)…`);
    if (spawnSync('npm', ['install', '-g', target.npmPackage], { stdio: 'inherit' }).status !== 0) {
      console.error('npm install failed. Re-run with sudo or fix npm prefix.');
      rl.close();
      process.exit(1);
    }
  }

  // Auth note (don't gate the switch on it — user can log in before restart)
  if (!target.isAuthed()) {
    warn(`Not yet logged in to ${target.name}. Run \`${target.bin}\` once to log in via browser, then restart the bot.`);
  } else {
    ok(`${target.name} is already logged in.`);
  }

  writeEnvProvider(target.name);
  ok(`Switched provider: ${current} → ${target.name}`);
  info('Restart the bot for the change to take effect:  bun run start');
  rl.close();
}

main().catch((e) => {
  console.error('\n\x1b[31m✗\x1b[0m', e instanceof Error ? e.message : e);
  rl.close();
  process.exit(1);
});
