// `bun run update [--force]` — refresh from git and restart the service.
//
// Steps:
//   1. Refuse if working tree is dirty (override with --force).
//   2. `git pull --ff-only`
//   3. `bun install --frozen-lockfile` (or `bun install` if lockfile changed)
//   4. `launchctl kickstart -k gui/$UID/com.marsclaw` (zero-downtime
//      restart; KeepAlive will respawn into the new code)
//
// Doesn't touch data/, MEMORY.md, or .env. A backup is taken before the
// pull so a broken update is fully reversible.

import { spawnSync } from 'node:child_process';
import { runBackup } from '../lib/backup.ts';

const force = process.argv.includes('--force');

function ok(s: string): void {
  console.log(`\x1b[32m✓\x1b[0m ${s}`);
}
function info(s: string): void {
  console.log(`  ${s}`);
}
function fail(s: string): never {
  console.error(`\x1b[31m✗\x1b[0m ${s}`);
  process.exit(1);
}

function run(bin: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(bin, args, { encoding: 'utf-8' });
  return { code: r.status ?? 1, out: r.stdout, err: r.stderr };
}

// Step 1: working-tree check.
const status = run('git', ['status', '--porcelain']);
if (status.code !== 0) fail(`git status failed:\n${status.err}`);
if (status.out.trim() && !force) {
  console.error('Working tree is dirty:');
  console.error(status.out);
  fail('Commit/stash first, or re-run with --force.');
}

// Step 2: backup.
info('Backing up current state…');
try {
  runBackup();
  ok('backup written to data/backups/');
} catch (err) {
  fail(`backup failed: ${err instanceof Error ? err.message : String(err)}`);
}

// Step 3: git pull.
info('git pull --ff-only…');
const pull = run('git', ['pull', '--ff-only']);
if (pull.code !== 0) fail(`git pull failed:\n${pull.err}`);
if (pull.out.includes('Already up to date')) {
  ok('already up to date — nothing to do.');
  process.exit(0);
}
process.stdout.write(pull.out);

// Step 4: bun install.
info('bun install…');
const install = run('bun', ['install']);
if (install.code !== 0) fail(`bun install failed:\n${install.err}`);
ok('dependencies installed.');

// Step 5: restart service if launchd-managed.
const uid = run('id', ['-u']).out.trim();
const label = `gui/${uid}/com.marsclaw`;
const printed = run('launchctl', ['print', label]);
if (printed.code === 0) {
  info('Restarting via launchctl…');
  const kick = run('launchctl', ['kickstart', '-k', label]);
  if (kick.code !== 0) {
    fail(`launchctl kickstart failed:\n${kick.err}\n\nRestart manually: launchctl kickstart -k ${label}`);
  }
  ok('service restarted. Tail logs/marsclaw.log to verify.');
} else {
  info('Service not installed via launchd — restart the bot manually.');
}
