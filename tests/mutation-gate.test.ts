import { describe, it, expect, afterEach } from 'bun:test';
import {
  isMutatingMethod,
  blockIfMutationsDisabled,
  blockIfMutatingMethodDisabled,
} from '../src/lib/mutation-gate.ts';
import { _resetConfigCacheForTests } from '../src/lib/config.ts';

function setMutating(enabled: boolean) {
  if (enabled) process.env.MARSCLAW_ALLOW_MUTATING_TOOLS = '1';
  else process.env.MARSCLAW_ALLOW_MUTATING_TOOLS = '0';
  _resetConfigCacheForTests();
}

afterEach(() => {
  delete process.env.MARSCLAW_ALLOW_MUTATING_TOOLS;
  _resetConfigCacheForTests();
});

describe('mutation gate', () => {
  it('classifies mutating vs read methods', () => {
    for (const m of [
      'events.patch',
      'events.delete',
      'spreadsheets.batchUpdate',
      'files.create',
      'permissions.create',
      'documents.batchUpdate',
      'spreadsheets.values.append',
    ]) {
      expect(isMutatingMethod(m)).toBe(true);
    }
    for (const m of [
      'calendarList.list',
      'freebusy.query',
      'spreadsheets.get',
      'files.export',
      'spreadsheets.values.batchGet',
      'events.list',
    ]) {
      expect(isMutatingMethod(m)).toBe(false);
    }
  });

  it('blocks always-mutating tools when disabled', async () => {
    setMutating(false);
    const r = await blockIfMutationsDisabled('gmail_send');
    expect(r?.isError).toBe(true);
    expect(r?.content[0]?.text).toContain('allow_mutating_tools');
  });

  it('allows always-mutating tools when enabled', async () => {
    setMutating(true);
    expect(await blockIfMutationsDisabled('gmail_send')).toBeNull();
  });

  it('lets read-only raw methods through even when mutations are disabled', async () => {
    setMutating(false);
    expect(await blockIfMutatingMethodDisabled('calendar_raw', 'events.list')).toBeNull();
    expect(await blockIfMutatingMethodDisabled('drive_raw', 'files.export')).toBeNull();
  });

  it('blocks write raw methods when disabled, allows when enabled', async () => {
    setMutating(false);
    expect((await blockIfMutatingMethodDisabled('drive_raw', 'files.create'))?.isError).toBe(true);
    setMutating(true);
    expect(await blockIfMutatingMethodDisabled('drive_raw', 'files.create')).toBeNull();
  });
});
