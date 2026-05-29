// Launchd service installer + controller for marsclaw.
//
// Subcommands:
//   install    — render plist with resolved paths, copy to LaunchAgents, bootstrap
//   uninstall  — bootout + remove plist
//   start      — load + run the (already-installed) service
//   stop       — bootout (stops the process; KeepAlive won't respawn) — plist stays
//   restart    — kickstart -k (SIGTERM; KeepAlive respawns into current code)
//   status     — print loaded state + log paths + binary-exists check
//   logs       — tail logs/marsclaw.log
//
// The launchctl primitives (start/stop/restart/isLoaded) live in ../lib/launchd.ts
// so the setup flow can reuse them. We use `launchctl bootstrap / bootout`
// (modern API) instead of the deprecated `launchctl load / unload`.

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeAtomic } from '../lib/atomic.ts';
import { log } from '../lib/log.ts';
import {
  SERVICE_LABEL,
  LAUNCHAGENTS_DIR,
  INSTALLED_PLIST,
  serviceUid,
  serviceTarget,
  isServiceLoaded,
  startService,
  stopService,
  restartService,
} from '../lib/launchd.ts';

const PLIST_TEMPLATE = 'launchd/com.marsclaw.plist';
const HARDENED_PLIST_TEMPLATE = 'launchd/com.marsclaw.hardened.plist';
const PROJECT_ROOT = process.cwd();
const HOME = homedir();

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf-8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// `--hardened` selects the supervisor plist (egress gateway + LLM proxy +
// sandboxed bot). Default install is unchanged — the plain plist runs the bot
// directly, exactly as before.
function renderPlist(hardened: boolean): string {
  const bunPath = which('bun');
  if (!bunPath) {
    throw new Error('bun not found on PATH — install it first (curl -fsSL https://bun.sh/install | bash)');
  }
  const tpl = readFileSync(hardened ? HARDENED_PLIST_TEMPLATE : PLIST_TEMPLATE, 'utf-8');
  return tpl
    .replaceAll('{{BUN_PATH}}', bunPath)
    .replaceAll('{{PROJECT_ROOT}}', PROJECT_ROOT)
    .replaceAll('{{HOME}}', HOME);
}

function install(hardened: boolean): void {
  mkdirSync(LAUNCHAGENTS_DIR, { recursive: true });
  mkdirSync(join(PROJECT_ROOT, 'logs'), { recursive: true });
  const plist = renderPlist(hardened);
  if (hardened) {
    log.info('installing HARDENED service (egress gateway + LLM proxy + sandbox)', {
      hint: 'enable layers via EnvironmentVariables in the installed plist',
    });
  }
  writeAtomic(INSTALLED_PLIST, plist);
  log.info('plist written', { path: INSTALLED_PLIST });

  // If a previous version is loaded, bootout first — bootstrap rejects duplicates.
  spawnSync('launchctl', ['bootout', serviceTarget()], { stdio: 'ignore' });

  const r = spawnSync('launchctl', ['bootstrap', `gui/${serviceUid()}`, INSTALLED_PLIST], {
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    log.error('launchctl bootstrap failed', { stderr: r.stderr.trim() });
    process.exit(1);
  }
  log.info('service installed and running');
  log.info('logs:   tail -F logs/marsclaw.log');
  log.info('errors: tail -F logs/marsclaw.error.log');
}

function uninstall(): void {
  spawnSync('launchctl', ['bootout', serviceTarget()], { stdio: 'inherit' });
  if (existsSync(INSTALLED_PLIST)) {
    unlinkSync(INSTALLED_PLIST);
    log.info('plist removed', { path: INSTALLED_PLIST });
  }
  log.info('service uninstalled');
}

function status(): void {
  const r = spawnSync('launchctl', ['print', serviceTarget()], { encoding: 'utf-8' });
  if (r.status !== 0) {
    log.warn('service not loaded', { hint: `run: bun run service install` });
    return;
  }
  // Extract a few interesting fields.
  const out = r.stdout;
  const pidMatch = out.match(/pid = (\d+)/);
  const stateMatch = out.match(/state = (\S+)/);
  const lastExitMatch = out.match(/last exit code = (\S+)/);
  log.info('service status', {
    label: SERVICE_LABEL,
    pid: pidMatch?.[1] ?? '-',
    state: stateMatch?.[1] ?? '-',
    last_exit: lastExitMatch?.[1] ?? '-',
  });

  // Sanity-check the Bun binary referenced in the plist still exists.
  const plistContent = existsSync(INSTALLED_PLIST) ? readFileSync(INSTALLED_PLIST, 'utf-8') : '';
  const bunMatch = plistContent.match(/<string>([^<]*\/bun)<\/string>/);
  if (bunMatch && !existsSync(bunMatch[1])) {
    log.warn('plist references a Bun binary that no longer exists', {
      path: bunMatch[1],
      fix: 'run: bun run service install',
    });
  }
}

function logs(): void {
  const logFile = join(PROJECT_ROOT, 'logs', 'marsclaw.log');
  if (!existsSync(logFile)) {
    log.warn('no log file yet', { path: logFile });
    return;
  }
  // Inherit so Ctrl-C cleanly stops tail.
  spawnSync('tail', ['-F', resolve(logFile)], { stdio: 'inherit' });
}

function start(): void {
  const r = startService();
  if (!r.ok) {
    log.fatal('failed to start service', { reason: r.reason, hint: 'run: bun run service install' });
    process.exit(1);
  }
  log.info('service started');
}

function stop(): void {
  if (!isServiceLoaded()) {
    log.warn('service not running', { label: SERVICE_LABEL });
    return;
  }
  const r = stopService();
  if (!r.ok) {
    log.error('launchctl bootout failed', { reason: r.reason });
    process.exit(1);
  }
  log.info('service stopped', { hint: 'start again: bun run service start' });
}

function restart(): void {
  if (!isServiceLoaded()) {
    log.fatal('service not loaded — run `bun run service install` first, or restart the foreground process by hand.');
    process.exit(1);
  }
  const r = restartService();
  if (!r.ok) {
    log.error('launchctl kickstart failed', { reason: r.reason });
    process.exit(1);
  }
  log.info('service restarted', { hint: 'tail logs/marsclaw.log to verify' });
}

const sub = process.argv[3] ?? 'status';
const hardened = process.argv.includes('--hardened');

switch (sub) {
  case 'install':
    install(hardened);
    break;
  case 'uninstall':
    uninstall();
    break;
  case 'start':
    start();
    break;
  case 'stop':
    stop();
    break;
  case 'restart':
    restart();
    break;
  case 'status':
    status();
    break;
  case 'logs':
    logs();
    break;
  default:
    log.fatal('unknown service subcommand', {
      sub,
      valid: ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs'],
    });
    process.exit(1);
}
