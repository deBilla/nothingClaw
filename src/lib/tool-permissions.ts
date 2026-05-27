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
// Escape hatch: MARSCLAW_TOOL_PERMISSIONS=bypass restores pre-hardening
// behaviour (everything allowed). One-release migration aid; remove next.

import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { log } from './log.ts';
import type { MarsclawConfig } from './config.ts';

const FS_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit']);
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
    log.warn('MARSCLAW_TOOL_PERMISSIONS=bypass — agent has unrestricted tool access (escape hatch)');
    return async (_toolName, input) => allowResult(input);
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
      return allowResult(input);
    }

    if (toolName === 'Bash') {
      const command = typeof input.command === 'string' ? input.command : '';
      for (const re of bashDeny) {
        if (re.test(command)) {
          log.warn('tool denied: Bash matches destructive pattern', {
            pattern: re.source,
            preview: command.slice(0, 120),
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
      return allowResult(input);
    }

    if (FS_TOOLS.has(toolName)) {
      const targets = extractPaths(input);
      for (const t of targets) {
        if (!isPathAllowed(t, allowedPaths)) {
          log.warn('tool denied: path outside allowed_paths', {
            tool: toolName,
            target: t,
            allowed: allowedPaths,
          });
          return denyResult(
            `Path ${t} is outside the allowed_paths. Add "${path.resolve(t)}" to ` +
              `data/config.json allowed_paths to grant access, or restart with ` +
              `MARSCLAW_TOOL_PERMISSIONS=bypass for a one-off override.`,
          );
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
      return allowResult(input);
    }

    // Anything else (Task, WebFetch, WebSearch, etc.) — allow.
    log.debug('tool allow: pass-through', { tool: toolName });
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
