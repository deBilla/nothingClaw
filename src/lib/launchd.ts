// macOS launchd service-control primitives, shared by the `service` CLI and the
// setup flow. Every function no-ops (returns { ok: false }) on non-macOS, where
// there's no launchd service to manage — so callers can use them unconditionally.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SERVICE_LABEL = 'com.marsclaw';
export const LAUNCHAGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
export const INSTALLED_PLIST = join(LAUNCHAGENTS_DIR, `${SERVICE_LABEL}.plist`);

const isMac = process.platform === 'darwin';

export function serviceUid(): string {
  return spawnSync('id', ['-u'], { encoding: 'utf-8' }).stdout.trim();
}

// Modern launchctl service target: gui/<uid>/<label>.
export function serviceTarget(): string {
  return `gui/${serviceUid()}/${SERVICE_LABEL}`;
}

export interface LaunchctlResult {
  ok: boolean;
  /** Present when ok is false — a short reason or launchctl stderr. */
  reason?: string;
}

const NOT_MAC: LaunchctlResult = { ok: false, reason: 'not macOS' };

// True only on macOS when the service is currently loaded into launchd.
export function isServiceLoaded(): boolean {
  if (!isMac) return false;
  return spawnSync('launchctl', ['print', serviceTarget()], { stdio: 'ignore' }).status === 0;
}

// The plist exists on disk (installed via `bun run service install`).
export function isServiceInstalled(): boolean {
  return isMac && existsSync(INSTALLED_PLIST);
}

function run(args: string[]): LaunchctlResult {
  const r = spawnSync('launchctl', args, { encoding: 'utf-8' });
  return r.status === 0
    ? { ok: true }
    : { ok: false, reason: r.stderr?.trim() || `launchctl exit ${r.status}` };
}

// Load + run the installed service: kickstart if already loaded, else bootstrap
// from the installed plist.
export function startService(): LaunchctlResult {
  if (!isMac) return NOT_MAC;
  if (isServiceLoaded()) return run(['kickstart', serviceTarget()]);
  if (!isServiceInstalled()) return { ok: false, reason: 'service not installed' };
  return run(['bootstrap', `gui/${serviceUid()}`, INSTALLED_PLIST]);
}

// Stop + unload (bootout). KeepAlive can't respawn it; the plist stays on disk
// so startService() can bring it back.
export function stopService(): LaunchctlResult {
  if (!isMac) return NOT_MAC;
  if (!isServiceLoaded()) return { ok: false, reason: 'not loaded' };
  return run(['bootout', serviceTarget()]);
}

// Restart in place: kickstart -k (SIGTERM; KeepAlive respawns into current code).
export function restartService(): LaunchctlResult {
  if (!isMac) return NOT_MAC;
  if (!isServiceLoaded()) return { ok: false, reason: 'not loaded' };
  return run(['kickstart', '-k', serviceTarget()]);
}
