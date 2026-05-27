import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { Provider } from './types.ts';

const HOME = process.env.HOME ?? '';

function geminiIsAuthed(): boolean {
  if (process.env.GEMINI_API_KEY) return true;
  const candidates = [
    join(HOME, '.gemini', 'oauth_creds.json'),
    join(HOME, '.config', 'gemini', 'oauth_creds.json'),
  ];
  return candidates.some((p) => existsSync(p) && statSync(p).size > 0);
}

// Resolve gemini to an absolute path. Under launchd, PATH won't include nvm's
// bin dir where the npm-global `gemini` lives, so bare PATH lookup fails with
// ENOENT. We check PATH first (cheap), then probe nvm + common npm-global
// install locations and return whichever exists.
function resolveGeminiBin(): string {
  if (process.env.GEMINI_BIN) return process.env.GEMINI_BIN;

  const onPath = spawnSync('which', ['gemini'], { encoding: 'utf-8' });
  if (onPath.status === 0 && onPath.stdout.trim()) return onPath.stdout.trim();

  const fallbacks: string[] = [];
  const nvmVersions = join(HOME, '.nvm', 'versions', 'node');
  if (existsSync(nvmVersions)) {
    try {
      for (const v of readdirSync(nvmVersions)) {
        fallbacks.push(join(nvmVersions, v, 'bin', 'gemini'));
      }
    } catch {
      /* unreadable — skip */
    }
  }
  fallbacks.push(
    join(HOME, '.npm-global', 'bin', 'gemini'),
    '/opt/homebrew/bin/gemini',
    '/usr/local/bin/gemini',
  );
  for (const p of fallbacks) {
    if (existsSync(p)) return p;
  }
  // Last resort: bare name. Will ENOENT and surface a clear error if it really
  // isn't installed.
  return 'gemini';
}

export const gemini: Provider = {
  name: 'gemini',
  bin: resolveGeminiBin(),
  npmPackage: '@google/gemini-cli',
  buildArgs(prompt) {
    // --skip-trust bypasses the trusted-folder gate (no human in this loop).
    return ['-p', prompt, '--skip-trust'];
  },
  isAuthed: geminiIsAuthed,
};
