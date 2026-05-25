// Thin wrapper over macOS `security` CLI for storing secrets in the login keychain.
// On non-macOS we fall back to plaintext files under data/secrets/ — same shape,
// just less secure. For a single-user local bot this is acceptable.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const SERVICE = 'nothingclaw';
const FALLBACK_DIR = 'data/secrets';
const isMac = process.platform === 'darwin';

export function setSecret(account: string, value: string): void {
  if (isMac) {
    // -U updates if exists. -s service, -a account, -w password.
    const r = spawnSync(
      'security',
      ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', value],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    if (r.status !== 0) {
      throw new Error(`keychain write failed: ${r.stderr?.toString().trim()}`);
    }
    return;
  }
  mkdirSync(FALLBACK_DIR, { recursive: true });
  const p = join(FALLBACK_DIR, `${account}.txt`);
  writeFileSync(p, value, 'utf8');
  chmodSync(p, 0o600);
}

export function getSecret(account: string): string | null {
  if (isMac) {
    const r = spawnSync(
      'security',
      ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (r.status !== 0) return null;
    return r.stdout.toString().trimEnd();
  }
  const p = join(FALLBACK_DIR, `${account}.txt`);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8').trimEnd();
}

export function deleteSecret(account: string): boolean {
  if (isMac) {
    const r = spawnSync(
      'security',
      ['delete-generic-password', '-s', SERVICE, '-a', account],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    return r.status === 0;
  }
  const p = join(FALLBACK_DIR, `${account}.txt`);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}
