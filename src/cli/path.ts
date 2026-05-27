// `bun run marsclaw path <sub>` — manage data/config.json allowed_paths.
//
// Subcommands:
//   list                       Show the current allow-list (with cwd-default note)
//   add <path>                 Add a path; resolves to absolute, dedupes
//   remove <path>              Remove a path (matches absolute resolution)
//   reset                      Clear the list (falls back to defaults = [cwd])
//
// Restart required after add/remove/reset for the agent process to pick up
// the new list. The CLI prints a reminder.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, writeConfig } from '../lib/config.ts';

const sub = process.argv[3];

function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}
function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
function ok(s: string): void {
  console.log(`\x1b[32m✓\x1b[0m ${s}`);
}
function warn(s: string): void {
  console.log(`\x1b[33m!\x1b[0m ${s}`);
}
function info(s: string): void {
  console.log(`  ${s}`);
}

function showList(): void {
  const cfg = loadConfig();
  console.log(bold('allowed_paths'));
  if (cfg.allowed_paths.length === 0) {
    info(dim('(empty)'));
    return;
  }
  for (const p of cfg.allowed_paths) {
    info(p);
  }
  console.log();
  info(dim('Edit via: marsclaw path add <path> | path remove <path> | path reset'));
}

function add(p: string): void {
  if (!p) {
    warn('Usage: marsclaw path add <path>');
    process.exit(1);
  }
  const abs = resolve(p);
  if (!existsSync(abs)) {
    warn(`Path does not exist: ${abs}`);
    warn('Adding it anyway — the agent will refuse access until the directory is created.');
  }
  const cfg = loadConfig();
  const next = [...new Set([...cfg.allowed_paths, abs])];
  writeConfig({ allowed_paths: next });
  ok(`Added ${abs}`);
  info(dim('Restart the bot (`bun run start`) for the agent to pick this up.'));
}

function remove(p: string): void {
  if (!p) {
    warn('Usage: marsclaw path remove <path>');
    process.exit(1);
  }
  const abs = resolve(p);
  const cfg = loadConfig();
  const next = cfg.allowed_paths.filter((x) => resolve(x) !== abs);
  if (next.length === cfg.allowed_paths.length) {
    warn(`Not in allowed_paths: ${abs}`);
    return;
  }
  writeConfig({ allowed_paths: next });
  ok(`Removed ${abs}`);
  info(dim('Restart the bot for the agent to pick this up.'));
}

function reset(): void {
  writeConfig({ allowed_paths: [process.cwd()] });
  ok(`Reset to default: [${process.cwd()}]`);
  info(dim('Restart the bot for the agent to pick this up.'));
}

switch (sub) {
  case 'list':
  case undefined:
    showList();
    break;
  case 'add':
    add(process.argv[4]);
    break;
  case 'remove':
  case 'rm':
    remove(process.argv[4]);
    break;
  case 'reset':
    reset();
    break;
  default:
    warn(`Unknown subcommand: ${sub}`);
    info('Usage: marsclaw path [list | add <path> | remove <path> | reset]');
    process.exit(1);
}
