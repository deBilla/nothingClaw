// canUseTool gate. Implements two checks:
//
// 1. Filesystem-touching tools (Read, Write, Edit, Glob, Grep, Bash, MultiEdit)
//    must operate on a path inside one of `config.allowed_paths`. Default
//    is just `[process.cwd()]` — the agent can touch the project root
//    and nothing else. Users add more via data/config.json `allowed_paths`.
//
// 2. Bash gets an additional destructive-command blocklist. Standard rules:
//      rm -rf /, chmod 000, dd of=, plus user-extendable config.extra_bash_denylist.
//
// There is no global bypass env var. A previous migration-aid escape hatch
// (`MARSCLAW_TOOL_PERMISSIONS=bypass`) was removed: a setting whose only effect
// is "disable every gate" is a foot-gun in a running deployment — a forgotten
// debug toggle silently turns the bot into a credential-exfil channel. To
// loosen behaviour for a specific case, edit data/config.json directly so the
// change is visible and reviewable.

import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { log } from './log.ts';
import { isSensitivePath, pathContainsSensitive } from './sensitive-paths.ts';
import { audit } from './audit-log.ts';
import { urlAllowed, urlHost } from './url-allowlist.ts';
import type { MarsclawConfig } from './config.ts';

const FS_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit']);
// Recursive FS tools — they walk into subdirectories. The per-target
// sensitive-path check below only validates the root they're given, so for
// these we additionally check whether the root *contains* a sensitive
// subtree, and we materialise the implicit cwd default so it goes through
// the same gates.
const RECURSIVE_FS_TOOLS = new Set(['Glob', 'Grep']);
// Network-egress tools. Disabled unless config.allow_web — with the agent
// reading untrusted content, an open fetch is an exfiltration channel.
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
// Write-style tools: when allowed, we ensure the parent directory exists
// so the agent doesn't need a separate Bash mkdir step. Without this, a
// reasonable `Write { file_path: 'wiki/profile.md' }` fails with ENOENT
// and the agent often mis-narrates that as a permission issue.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Path arguments per tool. Most use `file_path` / `path`; Glob/Grep can take `path`.
const PATH_ARG_KEYS = ['file_path', 'path', 'notebook_path'];

const DEFAULT_BASH_DENY: RegExp[] = [
  /\brm\s+-rf?\s+\/\s*(\s|$|;|&|\|)/, // rm -rf /
  /\brm\s+-rf?\s+~\/?(\s|$|;|&|\|)/,  // rm -rf ~
  /\brm\s+-rf?\s+\*\s*$/,             // rm -rf *
  /\bchmod\s+0+\b/,                   // chmod 000
  /\bdd\s+[^|]*\bof=/,                // dd of=…
  /\b:\(\)\s*\{\s*:\|:&\s*\}/,        // fork bomb
  /\bmkfs\b/,
  /\bshred\b/,
  /\bsecurity\s+find-generic-password\b/, // macOS Keychain secret extraction
  /\bdata\/secrets\b/,                // Linux refresh-token fallback store
];

function denyResult(message: string): PermissionResult {
  // `interrupt: false` is explicit — the harness Zod schema appears to
  // be stricter than the public type def lets on, and missing optional
  // fields can fail validation.
  return { behavior: 'deny', message, interrupt: false };
}

function allowResult(input: Record<string, unknown>): PermissionResult {
  // The harness expects `updatedInput` on every allow (it's the
  // "confirmed input" round-trip). Returning bare `{ behavior: 'allow' }`
  // fails Zod validation on the harness side and the tool call crashes
  // instead of executing — symptom is "permission/validation error"
  // surfaced as a tool failure to the agent.
  return { behavior: 'allow', updatedInput: input };
}

function isUnder(target: string, root: string): boolean {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isPathAllowed(target: string, allowed: string[]): boolean {
  return allowed.some((root) => isUnder(target, root));
}

function extractPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of PATH_ARG_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v.length > 0) paths.push(v);
  }
  return paths;
}

export function buildCanUseTool(config: MarsclawConfig): CanUseTool {
  if (process.env.MARSCLAW_TOOL_PERMISSIONS === 'bypass') {
    // Refuse to silently honour the legacy bypass var. Log loud and continue
    // with the real gate; the operator gets a one-time signal and the bot
    // doesn't quietly run unprotected.
    log.warn(
      'MARSCLAW_TOOL_PERMISSIONS=bypass is set but no longer honoured — unset it. The tool gate is always on.',
    );
  }

  const allowedPaths = config.allowed_paths.map((p) => path.resolve(p));
  const bashDeny = [
    ...DEFAULT_BASH_DENY,
    ...config.extra_bash_denylist.map((s) => new RegExp(s)),
  ];

  return async (toolName, input) => {
    // MCP tools (`mcp__<server>__<name>`) are always allowed. The MCP server
    // is our own code; if a tool there is dangerous, gate it inside the tool
    // itself, not here. canUseTool exists to bound the built-in agent tools
    // (Read/Write/Bash/etc), not our outbound chat plumbing.
    if (toolName.startsWith('mcp__')) {
      log.debug('tool allow: mcp tool', { tool: toolName });
      audit({ tool: toolName, decision: 'allow', layer: 'canUseTool' });
      return allowResult(input);
    }

    if (toolName === 'Bash') {
      const command = typeof input.command === 'string' ? input.command : '';
      // Shell is removed entirely unless explicitly enabled. A denylist can't
      // make shell safe against a prompt-injected agent; removing the
      // capability is the only sound control. (The tool is also in the SDK's
      // disallowedTools so the model never sees it; this is the backstop for
      // any path — e.g. sub-agents — that bypasses that list.)
      if (!config.allow_shell) {
        log.warn('tool denied: shell disabled (set allow_shell to enable)');
        audit({
          tool: 'Bash',
          decision: 'deny',
          layer: 'shell-disabled',
          subject: command.slice(0, 200),
          reason: 'allow_shell=false',
        });
        return denyResult(
          'Shell/Bash is disabled in this bot. Inform the user; do not retry. ' +
            'The operator can set "allow_shell": true in data/config.json to enable it.',
        );
      }
      for (const re of bashDeny) {
        if (re.test(command)) {
          log.warn('tool denied: Bash matches destructive pattern', {
            pattern: re.source,
            preview: command.slice(0, 120),
          });
          audit({
            tool: 'Bash',
            decision: 'deny',
            layer: 'canUseTool',
            subject: command.slice(0, 200),
            reason: `denylist:${re.source}`,
          });
          return denyResult(
            `Bash command rejected (matches denylist pattern ${re.source}). ` +
              `Edit data/config.json extra_bash_denylist to refine, or run a non-destructive equivalent.`,
          );
        }
      }
      // Bash with cd / output redirection can touch any path. We can't
      // reliably extract every target, so we don't path-check Bash itself
      // — paths are protected at the Read/Write/Edit layer below.
      log.debug('tool allow: Bash', { preview: command.slice(0, 120) });
      audit({ tool: 'Bash', decision: 'allow', layer: 'canUseTool', subject: command.slice(0, 200) });
      return allowResult(input);
    }

    if (FS_TOOLS.has(toolName)) {
      let targets = extractPaths(input);
      // Grep/Glob default to cwd when `path` is omitted. Materialise that
      // here so the cwd default goes through the same allowed/sensitive
      // checks as an explicit path — otherwise a bare `Grep({pattern:...})`
      // silently scans the bot process's cwd, bypassing allowed_paths.
      if (RECURSIVE_FS_TOOLS.has(toolName) && targets.length === 0) {
        targets = [process.cwd()];
      }
      // Sensitive files (.env, data/config.json, data/secrets, provider creds)
      // are off-limits even though they sit inside an allowed_paths root. This
      // protects credentials and stops the agent from widening its own sandbox
      // by rewriting config. Checked before the allow-list so it always wins.
      for (const t of targets) {
        if (isSensitivePath(t)) {
          log.warn('tool denied: sensitive path', { tool: toolName, target: t });
          audit({ tool: toolName, decision: 'deny', layer: 'sensitive-paths', subject: t });
          return denyResult(
            `Path ${t} holds secrets or marsClaw's own permission config and is off-limits to file tools.`,
          );
        }
      }
      for (const t of targets) {
        if (!isPathAllowed(t, allowedPaths)) {
          log.warn('tool denied: path outside allowed_paths', {
            tool: toolName,
            target: t,
            allowed: allowedPaths,
          });
          audit({
            tool: toolName,
            decision: 'deny',
            layer: 'canUseTool',
            subject: t,
            reason: 'outside allowed_paths',
          });
          return denyResult(
            `Path ${t} is outside the allowed_paths. Add "${path.resolve(t)}" to ` +
              `data/config.json allowed_paths to grant access (no env override exists).`,
          );
        }
      }
      // Recursive tools (Grep, Glob) walk into subdirectories — the per-target
      // sensitive check only validates the *root* they're given, not what gets
      // traversed. If the root straddles a sensitive subtree (e.g. the repo
      // root contains .env), the tool would return matches from it. Require
      // the agent to narrow the search.
      if (RECURSIVE_FS_TOOLS.has(toolName)) {
        for (const t of targets) {
          if (pathContainsSensitive(t)) {
            log.warn('tool denied: recursive search contains sensitive subtree', {
              tool: toolName,
              root: t,
            });
            audit({
              tool: toolName,
              decision: 'deny',
              layer: 'sensitive-paths',
              subject: t,
              reason: 'root contains sensitive subtree',
            });
            return denyResult(
              `Search root ${t} contains sensitive files (.env, data/secrets, data/config.json, etc.). ` +
                `Narrow your search to a subdirectory that excludes them (e.g. "src/", "wiki/") and try again.`,
            );
          }
        }
      }
      // Allowed write — ensure parent dir exists so Claude Code's Write
      // doesn't bounce with ENOENT (and so the agent doesn't mis-narrate
      // that as a permission error to the user).
      if (WRITE_TOOLS.has(toolName)) {
        for (const t of targets) {
          const parent = path.dirname(path.resolve(t));
          if (!existsSync(parent)) {
            try {
              mkdirSync(parent, { recursive: true });
              log.info('auto-mkdir for agent write', { tool: toolName, dir: parent });
            } catch (err) {
              // mkdir failures are usually permission errors on the real
              // filesystem (e.g. parent's parent is read-only). Let the
              // Write tool surface the real error rather than masking.
              log.warn('auto-mkdir failed', { dir: parent, err });
            }
          }
        }
      }
      log.debug('tool allow: fs tool', { tool: toolName, targets });
      audit({ tool: toolName, decision: 'allow', layer: 'canUseTool', subject: targets.join(', ').slice(0, 200) });
      return allowResult(input);
    }

    if (WEB_TOOLS.has(toolName)) {
      if (!config.allow_web) {
        log.warn('tool denied: web egress disabled (set allow_web to enable)', { tool: toolName });
        audit({ tool: toolName, decision: 'deny', layer: 'web-disabled', reason: 'allow_web=false' });
        return denyResult(
          `${toolName} is disabled in this bot (web egress is an exfiltration channel for an agent ` +
            `that reads untrusted content). Inform the user; the operator can set "allow_web": true ` +
            `in data/config.json to enable it.`,
        );
      }
      // WebSearch talks only to the model provider's search backend (no
      // arbitrary host), so it doesn't need a host allow-list. WebFetch *does*
      // — that's the exfil vector the allow-list closes.
      if (toolName === 'WebFetch') {
        const url = typeof input.url === 'string' ? input.url : '';
        // When egress is routed through the gateway AND that routing is
        // actually enforced (the launch wrapper asserts MARSCLAW_EGRESS_ENFORCED
        // after establishing netns/pf), the SSRF-protected gateway is the
        // boundary and the per-host allow-list is bypassed. We still reject
        // non-http(s) and loopback URLs here — those are never legitimate and
        // failing at the gate is clearer than failing at the proxy.
        const egressEnforced =
          config.egress_mode === 'gateway' && process.env.MARSCLAW_EGRESS_ENFORCED === '1';
        if (egressEnforced) {
          if (urlHost(url) === null) {
            audit({ tool: 'WebFetch', decision: 'deny', layer: 'egress-gateway', subject: url.slice(0, 200), reason: 'non-http(s) or loopback url' });
            return denyResult(`Fetch denied: ${url} is not a valid remote http(s) URL.`);
          }
          audit({ tool: 'WebFetch', decision: 'allow', layer: 'egress-gateway', subject: url.slice(0, 200), reason: 'gateway-enforced' });
        } else if (!urlAllowed(url, config.allowed_web_domains)) {
          log.warn('tool denied: WebFetch url not on allow-list', {
            url,
            allowlist: config.allowed_web_domains,
          });
          audit({
            tool: 'WebFetch',
            decision: 'deny',
            layer: 'url-allowlist',
            subject: url.slice(0, 200),
            reason: config.allowed_web_domains.length === 0 ? 'allowlist empty' : 'host not in allowlist',
          });
          return denyResult(
            `Fetch denied: the host of ${url} is not on the allowlist. ` +
              `Inform the user; do not retry, do not try a different URL on the same host. ` +
              `To grant access the operator must add the domain to "allowed_web_domains" in ` +
              `data/config.json and restart.`,
          );
        } else {
          audit({ tool: 'WebFetch', decision: 'allow', layer: 'url-allowlist', subject: url.slice(0, 200) });
        }
      } else {
        audit({ tool: toolName, decision: 'allow', layer: 'canUseTool' });
      }
      log.debug('tool allow: web tool', { tool: toolName });
      return allowResult(input);
    }

    // Anything else (Task, etc.) — allow.
    log.debug('tool allow: pass-through', { tool: toolName });
    audit({ tool: toolName, decision: 'allow', layer: 'canUseTool' });
    return allowResult(input);
  };
}

// Pre-resolved list of MCP tool names exposed by our local MCP server.
// Passed to the SDK `allowedTools` so they're auto-allowed without going
// through any prompt flow at all (belt-and-braces with the canUseTool path
// above).
export const MARSCLAW_MCP_TOOLS = [
  'mcp__marsclaw__send_message',
  'mcp__marsclaw__send_file',
  'mcp__marsclaw__speak',
  'mcp__marsclaw__google_accounts',
  'mcp__marsclaw__gmail_recent',
  'mcp__marsclaw__gmail_search',
  'mcp__marsclaw__gmail_get',
  'mcp__marsclaw__gmail_send',
  'mcp__marsclaw__contacts_search',
  'mcp__marsclaw__calendar_list_events',
  'mcp__marsclaw__calendar_create_event',
  'mcp__marsclaw__calendar_raw',
  'mcp__marsclaw__drive_search',
  'mcp__marsclaw__drive_read',
  'mcp__marsclaw__drive_raw',
  'mcp__marsclaw__sheets_read',
  'mcp__marsclaw__sheets_write',
  'mcp__marsclaw__sheets_raw',
  'mcp__marsclaw__docs_read',
  'mcp__marsclaw__docs_raw',
  'mcp__marsclaw__slides_read',
  'mcp__marsclaw__slides_raw',
];
