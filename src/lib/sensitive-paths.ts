// Files/dirs that hold secrets or marsClaw's own permission config. These are
// off-limits to the agent's filesystem-touching tools (Read/Write/Edit/Glob/
// Grep) and to send_file — even when they fall inside an `allowed_paths` root,
// which `.env` and `data/` do by default.
//
// Why: the agent ingests untrusted content (email bodies via gmail_get, web
// pages via WebFetch). A prompt-injected turn must not be able to (a) read its
// own credentials or (b) widen its own sandbox by rewriting config.
//
// LIMITATION: this guards the structured file tools and send_file only. Bash
// is NOT path-checked (it can `cd`/redirect anywhere), so a determined
// `cat .env` still works. Closing that hole needs a credential broker / real
// sandbox — see docs/vs-nanoclaw.md. This raises the bar; it is not airtight.
//
// Symlink resolution: every check goes through `realpath` first so an agent
// (with shell access) that does `ln -s ~/.claude.json data/sym` can't then
// `Read({file_path: 'data/sym'})` past the gate. Falls back to plain `resolve`
// when the path doesn't yet exist, so write-targets are still validated.

import path from 'node:path';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';

const HOME = homedir();

// Resolved once at load against the process cwd (the project root).
export const SENSITIVE_PATHS: string[] = [
  path.resolve('.env'), // channel tokens, Google OAuth client id/secret
  path.resolve('data/config.json'), // allowed_paths, denylist, budget — self-escalation surface
  path.resolve('data/secrets'), // Linux refresh-token fallback files
  path.resolve('data/whatsapp-auth'), // Baileys session credentials
  path.resolve('data/marsclaw.db'), // chat history (not a credential, but contains everything you've ever said)
  path.join(HOME, '.claude.json'), // Claude Code OAuth / API key
  path.join(HOME, '.claude'), // Claude Code session transcripts
  path.join(HOME, '.gemini'), // Gemini CLI credentials
].map((p) => path.resolve(p));

// Resolve a path through any leading symlinks so a `data/sym -> ~/.claude.json`
// link can't sneak past the sensitive check. realpath throws ENOENT for paths
// that don't exist yet (legitimate for Write targets); fall back to plain
// resolve in that case — write-side gates still want to compare the literal
// target. For partially-existing paths (parent exists, leaf doesn't) we walk
// up to find the nearest existing ancestor, realpath that, and rejoin the
// remaining suffix; that catches a Write to `data/sym/inside/x.txt` when
// `data/sym` is a symlink.
function resolveSymlinks(target: string): string {
  const resolved = path.resolve(target);
  try {
    return realpathSync(resolved);
  } catch (err) {
    void err;
  }
  // Walk up to find an existing ancestor and re-suffix the rest.
  const segs = resolved.split(path.sep);
  for (let i = segs.length - 1; i > 0; i--) {
    const prefix = segs.slice(0, i).join(path.sep) || path.sep;
    try {
      const realPrefix = realpathSync(prefix);
      return path.join(realPrefix, ...segs.slice(i));
    } catch (err) {
      void err;
      continue;
    }
  }
  return resolved;
}

function isUnder(target: string, root: string): boolean {
  const rel = path.relative(root, resolveSymlinks(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** True when `target` is one of, or inside, a sensitive path. */
export function isSensitivePath(target: string): boolean {
  return SENSITIVE_PATHS.some((s) => isUnder(target, s));
}

/**
 * True when `rootPath` *contains* (is an ancestor of) any sensitive path.
 * Used to gate recursive tools (Grep, Glob): the per-target sensitive check
 * only validates the search ROOT, not what gets walked. If the root straddles
 * a sensitive subtree, the recursive tool would return its contents — so we
 * require the search to be narrowed to a non-straddling subdirectory.
 */
export function pathContainsSensitive(rootPath: string): boolean {
  const resolved = resolveSymlinks(rootPath);
  return SENSITIVE_PATHS.some((s) => isUnder(s, resolved));
}
