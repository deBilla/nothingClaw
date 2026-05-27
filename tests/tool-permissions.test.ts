import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCanUseTool } from '../src/lib/tool-permissions.ts';
import type { MarsclawConfig } from '../src/lib/config.ts';

function configWith(overrides: Partial<MarsclawConfig>): MarsclawConfig {
  return {
    bot_name: 'Mars',
    allowed_jids: [],
    allowed_paths: ['/tmp/test-project'],
    max_sessions: 20,
    idle_ms: 900_000,
    timezone: 'UTC',
    voice_enabled: false,
    agent_provider: 'claude',
    extra_bash_denylist: [],
    ...overrides,
  };
}

async function call(
  fn: ReturnType<typeof buildCanUseTool>,
  tool: string,
  input: Record<string, unknown>,
) {
  return fn(tool, input, { signal: new AbortController().signal });
}

describe('canUseTool', () => {
  it('allows Read inside an allowed path', async () => {
    const fn = buildCanUseTool(configWith({}));
    const r = await call(fn, 'Read', { file_path: '/tmp/test-project/foo.md' });
    expect(r.behavior).toBe('allow');
  });

  it('allow response carries updatedInput so the harness can Zod-validate', async () => {
    // The Claude Code harness rejects a bare `{ behavior: "allow" }` as
    // a malformed permission response (Zod validation fail) — it expects
    // updatedInput as the confirmed-input round-trip. Without this, tool
    // calls crash on the permission boundary instead of executing.
    const fn = buildCanUseTool(configWith({}));
    const input = { file_path: '/tmp/test-project/foo.md', content: 'x' };
    const r = await call(fn, 'Write', input);
    expect(r.behavior).toBe('allow');
    if (r.behavior === 'allow') {
      expect(r.updatedInput).toEqual(input);
    }
  });

  it('deny response includes interrupt:false to match wire-protocol expectations', async () => {
    const fn = buildCanUseTool(configWith({}));
    const r = await call(fn, 'Write', { file_path: '/etc/passwd' });
    expect(r.behavior).toBe('deny');
    if (r.behavior === 'deny') {
      expect(r.interrupt).toBe(false);
      expect(typeof r.message).toBe('string');
    }
  });

  it('denies Read outside allowed paths', async () => {
    const fn = buildCanUseTool(configWith({}));
    const r = await call(fn, 'Read', { file_path: '/etc/passwd' });
    expect(r.behavior).toBe('deny');
  });

  it('denies Write into ~/ when not in allow-list', async () => {
    const fn = buildCanUseTool(configWith({}));
    const r = await call(fn, 'Write', { file_path: '/Users/anyone/Desktop/x.txt' });
    expect(r.behavior).toBe('deny');
  });

  it('allows additional paths from config', async () => {
    const fn = buildCanUseTool(configWith({ allowed_paths: ['/tmp/test-project', '/tmp/notes'] }));
    const r = await call(fn, 'Read', { file_path: '/tmp/notes/idea.md' });
    expect(r.behavior).toBe('allow');
  });

  it('denies Bash with destructive patterns', async () => {
    const fn = buildCanUseTool(configWith({}));
    expect((await call(fn, 'Bash', { command: 'rm -rf /' })).behavior).toBe('deny');
    expect((await call(fn, 'Bash', { command: 'chmod 000 file' })).behavior).toBe('deny');
    expect((await call(fn, 'Bash', { command: 'dd if=/dev/zero of=/dev/sda' })).behavior).toBe('deny');
  });

  it('allows safe Bash', async () => {
    const fn = buildCanUseTool(configWith({}));
    expect((await call(fn, 'Bash', { command: 'ls -la' })).behavior).toBe('allow');
    expect((await call(fn, 'Bash', { command: 'echo hello' })).behavior).toBe('allow');
  });

  it('honours extra_bash_denylist', async () => {
    const fn = buildCanUseTool(configWith({ extra_bash_denylist: ['npm publish'] }));
    expect((await call(fn, 'Bash', { command: 'npm publish' })).behavior).toBe('deny');
    expect((await call(fn, 'Bash', { command: 'npm test' })).behavior).toBe('allow');
  });

  it('allows non-filesystem tools', async () => {
    const fn = buildCanUseTool(configWith({}));
    expect((await call(fn, 'WebFetch', { url: 'https://example.com' })).behavior).toBe('allow');
    expect((await call(fn, 'Task', { prompt: 'x' })).behavior).toBe('allow');
  });

  it('always allows mcp__ tools (no path / command checks)', async () => {
    const fn = buildCanUseTool(configWith({}));
    expect((await call(fn, 'mcp__marsclaw__speak', { text: 'hi' })).behavior).toBe('allow');
    expect((await call(fn, 'mcp__marsclaw__send_message', { text: 'hi' })).behavior).toBe('allow');
    expect((await call(fn, 'mcp__marsclaw__gmail_recent', { count: 5 })).behavior).toBe('allow');
  });

  describe('auto-mkdir for Write tools', () => {
    const SANDBOX = join(tmpdir(), `marsclaw-permtest-${process.pid}`);
    beforeEach(() => {
      if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true });
      mkdirSync(SANDBOX, { recursive: true });
    });
    afterEach(() => {
      if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true });
    });

    it('creates parent directories for Write when missing', async () => {
      const fn = buildCanUseTool(configWith({ allowed_paths: [SANDBOX] }));
      const target = join(SANDBOX, 'wiki', 'profile.md');
      expect(existsSync(join(SANDBOX, 'wiki'))).toBe(false);
      const r = await call(fn, 'Write', { file_path: target });
      expect(r.behavior).toBe('allow');
      expect(existsSync(join(SANDBOX, 'wiki'))).toBe(true);
    });

    it('does not mkdir for read-only tools', async () => {
      const fn = buildCanUseTool(configWith({ allowed_paths: [SANDBOX] }));
      const target = join(SANDBOX, 'nope', 'thing.md');
      await call(fn, 'Read', { file_path: target });
      expect(existsSync(join(SANDBOX, 'nope'))).toBe(false);
    });

    it('does not mkdir when path is denied', async () => {
      const fn = buildCanUseTool(configWith({ allowed_paths: [SANDBOX] }));
      const outside = join(tmpdir(), `marsclaw-permtest-OUTSIDE-${process.pid}`);
      const r = await call(fn, 'Write', { file_path: join(outside, 'x.md') });
      expect(r.behavior).toBe('deny');
      expect(existsSync(outside)).toBe(false);
    });
  });

  it('bypass env restores unrestricted access', async () => {
    const before = process.env.MARSCLAW_TOOL_PERMISSIONS;
    process.env.MARSCLAW_TOOL_PERMISSIONS = 'bypass';
    try {
      const fn = buildCanUseTool(configWith({}));
      expect((await call(fn, 'Read', { file_path: '/etc/passwd' })).behavior).toBe('allow');
      expect((await call(fn, 'Bash', { command: 'rm -rf /' })).behavior).toBe('allow');
    } finally {
      if (before === undefined) delete process.env.MARSCLAW_TOOL_PERMISSIONS;
      else process.env.MARSCLAW_TOOL_PERMISSIONS = before;
    }
  });
});
