// Google account management (multi-account capable).
//
//   marsclaw google login [alias] [--scope <url>]...   OAuth dance, stash refresh token
//   marsclaw google list                                List configured accounts
//   marsclaw google use <alias>                         Mark <alias> as the default
//   marsclaw google status [alias]                      Show creds + scopes for an account
//   marsclaw google logout [alias]                      Remove a stored account
//   marsclaw google test [alias]                        List 5 most-recent Gmail subjects

import {
  listAccounts,
  loginInteractive,
  removeAccount,
  resolveAccount,
  setDefaultAccount,
  storedScopes,
} from '../google/auth.ts';
import { listRecent } from '../google/gmail.ts';

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
];

const args = process.argv.slice(3);
const sub = args[0] ?? 'list';

switch (sub) {
  case 'login': {
    const { positional, scopes } = parseLoginArgs(args.slice(1));
    const alias = positional[0] ?? 'default';
    await loginInteractive(scopes.length ? scopes : DEFAULT_SCOPES, alias);
    break;
  }
  case 'list': {
    const idx = listAccounts();
    if (idx.accounts.length === 0) {
      console.log('No Google accounts connected. Run: marsclaw google login [alias]');
      break;
    }
    for (const a of idx.accounts) {
      console.log(`${a === idx.default ? '* ' : '  '}${a}`);
    }
    break;
  }
  case 'use': {
    const alias = args[1];
    if (!alias) {
      console.error('Usage: marsclaw google use <alias>');
      process.exit(1);
    }
    setDefaultAccount(alias);
    console.log(`Default account is now "${alias}".`);
    break;
  }
  case 'status': {
    try {
      const account = resolveAccount(args[1]);
      console.log(`Account: ${account}`);
      const scopes = storedScopes(account);
      if (scopes.length) {
        console.log('Scopes:');
        for (const s of scopes) console.log(`  - ${s}`);
      }
    } catch (err) {
      console.log(err instanceof Error ? err.message : String(err));
    }
    break;
  }
  case 'logout': {
    const alias = args[1];
    if (!alias) {
      console.error('Usage: marsclaw google logout <alias>');
      process.exit(1);
    }
    const removed = removeAccount(alias);
    console.log(removed ? `Disconnected "${alias}".` : `Nothing to remove for "${alias}".`);
    break;
  }
  case 'test': {
    const account = args[1];
    const msgs = await listRecent(5, account);
    for (const m of msgs) {
      console.log(`• ${m.subject || '(no subject)'}  — ${m.from}`);
    }
    break;
  }
  default:
    console.error(`Unknown google subcommand: ${sub}`);
    console.error('Usage: marsclaw google [login|list|use|status|logout|test]');
    process.exit(1);
}

function parseLoginArgs(rest: string[]): { positional: string[]; scopes: string[] } {
  const positional: string[] = [];
  const scopes: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--scope' && rest[i + 1]) {
      scopes.push(rest[++i]!);
    } else if (a && !a.startsWith('--')) {
      positional.push(a);
    }
  }
  return { positional, scopes };
}
