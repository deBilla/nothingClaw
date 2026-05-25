// Google OAuth — installed-app flow with a loopback redirect.
// Supports multiple Google accounts via a short alias ("personal", "work").
//
// Storage layout (macOS Keychain or 0600 fallback files):
//   google-accounts                  JSON { default: alias, accounts: alias[] }
//   google-refresh-token:<alias>     refresh token for that account
//   google-scopes:<alias>            space-separated scopes granted to that account
//
// Legacy single-account secrets (`google-refresh-token`, `google-scopes`) are
// migrated to alias "default" on first read.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { deleteSecret, getSecret, setSecret } from './keychain.ts';

const INDEX_KEY = 'google-accounts';
const TOKEN_PREFIX = 'google-refresh-token';
const SCOPES_PREFIX = 'google-scopes';
const LEGACY_TOKEN_KEY = 'google-refresh-token';
const LEGACY_SCOPES_KEY = 'google-scopes';

interface AccountIndex {
  default: string | null;
  accounts: string[];
}

function readIndex(): AccountIndex {
  migrateLegacy();
  const raw = getSecret(INDEX_KEY);
  if (!raw) return { default: null, accounts: [] };
  try {
    const parsed = JSON.parse(raw) as AccountIndex;
    return { default: parsed.default ?? null, accounts: parsed.accounts ?? [] };
  } catch {
    return { default: null, accounts: [] };
  }
}

function writeIndex(idx: AccountIndex): void {
  setSecret(INDEX_KEY, JSON.stringify(idx));
}

function migrateLegacy(): void {
  const idxRaw = getSecret(INDEX_KEY);
  if (idxRaw) return; // already migrated or already on the new layout
  const legacy = getSecret(LEGACY_TOKEN_KEY);
  if (!legacy) return;
  const alias = 'default';
  setSecret(`${TOKEN_PREFIX}:${alias}`, legacy);
  const legacyScopes = getSecret(LEGACY_SCOPES_KEY);
  if (legacyScopes) setSecret(`${SCOPES_PREFIX}:${alias}`, legacyScopes);
  setSecret(INDEX_KEY, JSON.stringify({ default: alias, accounts: [alias] } satisfies AccountIndex));
  // Leave legacy keys in place; harmless and lets us roll back if anything goes wrong.
}

function readEnvCreds(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set. ' +
        'Create OAuth credentials in Google Cloud Console → APIs & Services → ' +
        'Credentials → Create OAuth client ID → Desktop app.',
    );
  }
  return { clientId, clientSecret };
}

export function listAccounts(): { default: string | null; accounts: string[] } {
  return readIndex();
}

export function resolveAccount(alias?: string): string {
  const idx = readIndex();
  if (alias) {
    if (!idx.accounts.includes(alias)) {
      throw new Error(
        `Unknown Google account "${alias}". Known: ${idx.accounts.join(', ') || '(none)'}. ` +
          `Add one with: nothingclaw google login ${alias}`,
      );
    }
    return alias;
  }
  if (idx.default) return idx.default;
  if (idx.accounts.length === 1) return idx.accounts[0]!;
  if (idx.accounts.length === 0) {
    throw new Error('No Google accounts connected. Run: nothingclaw google login');
  }
  throw new Error(
    `Multiple accounts configured (${idx.accounts.join(', ')}) but no default set. ` +
      `Pick one with: nothingclaw google use <alias>`,
  );
}

export async function loginInteractive(scopes: string[], alias = 'default'): Promise<void> {
  const { clientId, clientSecret } = readEnvCreds();

  const { port, codePromise } = await startLoopbackServer();
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force refresh_token issuance every login
    scope: scopes,
  });

  console.log(`Opening browser for Google consent (account: ${alias})...\nIf nothing opens, visit:\n${authUrl}\n`);
  openBrowser(authUrl);

  const code = await codePromise;
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'No refresh_token returned. Revoke prior consent at https://myaccount.google.com/permissions and retry.',
    );
  }
  setSecret(`${TOKEN_PREFIX}:${alias}`, tokens.refresh_token);
  setSecret(`${SCOPES_PREFIX}:${alias}`, scopes.join(' '));

  const idx = readIndex();
  if (!idx.accounts.includes(alias)) idx.accounts.push(alias);
  if (!idx.default) idx.default = alias;
  writeIndex(idx);

  console.log(`✓ Stored refresh token for "${alias}" in keychain.`);
  if (idx.default !== alias) {
    console.log(`  (default account is still "${idx.default}"; switch with: nothingclaw google use ${alias})`);
  }
}

export function getAuthedClient(alias?: string): OAuth2Client {
  const { clientId, clientSecret } = readEnvCreds();
  const account = resolveAccount(alias);
  const refreshToken = getSecret(`${TOKEN_PREFIX}:${account}`);
  if (!refreshToken) {
    throw new Error(`No stored credentials for account "${account}". Run: nothingclaw google login ${account}`);
  }
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

export function storedScopes(alias?: string): string[] {
  const account = resolveAccount(alias);
  const raw = getSecret(`${SCOPES_PREFIX}:${account}`);
  return raw ? raw.split(' ').filter(Boolean) : [];
}

export function setDefaultAccount(alias: string): void {
  const idx = readIndex();
  if (!idx.accounts.includes(alias)) {
    throw new Error(`Unknown account "${alias}". Known: ${idx.accounts.join(', ') || '(none)'}.`);
  }
  idx.default = alias;
  writeIndex(idx);
}

export function removeAccount(alias: string): boolean {
  const idx = readIndex();
  if (!idx.accounts.includes(alias)) return false;
  deleteSecret(`${TOKEN_PREFIX}:${alias}`);
  deleteSecret(`${SCOPES_PREFIX}:${alias}`);
  idx.accounts = idx.accounts.filter((a) => a !== alias);
  if (idx.default === alias) idx.default = idx.accounts[0] ?? null;
  writeIndex(idx);
  return true;
}

interface LoopbackResult {
  port: number;
  codePromise: Promise<string>;
}

function startLoopbackServer(): Promise<LoopbackResult> {
  return new Promise((resolve, reject) => {
    let resolveCode: (v: string) => void;
    let rejectCode: (e: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400).end();
        return;
      }
      const url = new URL(req.url, `http://127.0.0.1`);
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (err) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end(`OAuth error: ${err}`);
        rejectCode(new Error(`OAuth error: ${err}`));
      } else if (code) {
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<html><body><h2>Authorized.</h2>You can close this tab.</body></html>');
        resolveCode(code);
      } else {
        res.writeHead(400).end('Missing code');
        rejectCode(new Error('Missing code in callback'));
      }
      setTimeout(() => server.close(), 100);
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind loopback server'));
        return;
      }
      resolve({ port: addr.port, codePromise });
    });
  });
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
}
