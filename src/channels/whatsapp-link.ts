// One-shot WhatsApp device-linking for the setup flow.
//
// The full channel adapter (createWhatsappChannel) wires message handling,
// rate limiting, pairing, etc. — too heavy for "just print a QR and wait until
// the phone links." This is the minimal version: open a socket, render the QR,
// resolve once the connection reaches 'open' (creds saved to AUTH_DIR), then
// close WITHOUT logging out so the saved credentials persist for `bun run start`.

import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, type WASocket } from 'baileys';
import type { Boom } from '@hapi/boom';

const AUTH_DIR = process.env.MARSCLAW_WHATSAPP_AUTH ?? 'data/whatsapp-auth';

// A `me`-set-but-`registered:false` creds.json is the fingerprint of a prior
// aborted scan: WhatsApp accepted the device and wrote our identity, but the
// post-scan 515 reconnect never landed, so the session is half-built. Reusing
// it on the next link attempt produces an immediate 401 loggedOut. Detect and
// wipe before opening a socket.
function wipePartialAuth(): void {
  const credsPath = join(AUTH_DIR, 'creds.json');
  if (!existsSync(credsPath)) return;
  try {
    const c = JSON.parse(readFileSync(credsPath, 'utf-8')) as { me?: unknown; registered?: boolean };
    if (c.me && !c.registered) {
      rmSync(AUTH_DIR, { recursive: true, force: true });
      mkdirSync(AUTH_DIR, { recursive: true });
    }
  } catch {
    // Unreadable creds.json — safer to start clean than to feed garbage to Baileys.
    rmSync(AUTH_DIR, { recursive: true, force: true });
    mkdirSync(AUTH_DIR, { recursive: true });
  }
}

export type LinkStatus = 'already-linked' | 'linked' | 'timeout' | 'failed';

export interface LinkResult {
  status: LinkStatus;
  detail?: string;
}

// Renders a QR (if WhatsApp isn't already linked) and resolves when the phone
// completes the link or the timeout elapses. Never throws — callers branch on
// `status` and fall back to the first-start QR if anything goes sideways.
export async function linkWhatsapp(opts: { timeoutMs?: number } = {}): Promise<LinkResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  mkdirSync(AUTH_DIR, { recursive: true });
  wipePartialAuth();

  const initial = await useMultiFileAuthState(AUTH_DIR);
  if (initial.state.creds.registered) return { status: 'already-linked' };

  return await new Promise<LinkResult>((resolve) => {
    let settled = false;
    let printedQr = false;
    let sock: WASocket | null = null;

    const finish = (r: LinkResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Close the socket but keep the freshly written creds — `sock.logout()`
      // would unlink the device, which is the opposite of what we want.
      try {
        sock?.end(undefined);
      } catch (err) {
        void err;
      }
      resolve(r);
    };

    const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);

    // Open (and re-open after 515) the socket, attaching all handlers. Baileys'
    // post-scan flow is: QR → scanned → close with restartRequired (515) →
    // reconnect with saved creds → open (registered=true). Without the reconnect
    // step the link never settles as `linked`.
    const open = async (): Promise<void> => {
      if (settled) return;
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }) });
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (u) => {
        if (settled) return;
        if (u.qr && !printedQr) {
          printedQr = true;
          console.log('\n  Scan this with WhatsApp → Settings → Linked devices → Link a device:\n');
          qrcode.generate(u.qr, { small: true });
        } else if (u.qr) {
          // Baileys refreshes the QR every ~20s; redraw so a slow scan still works.
          qrcode.generate(u.qr, { small: true });
        }
        if (u.connection === 'open') {
          // Give a final creds.update a beat to flush before we tear down.
          setTimeout(() => finish({ status: 'linked' }), 1500);
        }
        if (u.connection === 'close') {
          const code = (u.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) {
            finish({ status: 'failed', detail: 'logged out during linking' });
            return;
          }
          if (code === DisconnectReason.restartRequired) {
            // Normal post-scan reconnect — saveCreds has already persisted the
            // new identity, so re-opening with a fresh auth state lands as
            // `connection === 'open'` with `registered = true`.
            try {
              sock?.end(undefined);
            } catch (err) {
              void err;
            }
            void open();
            return;
          }
          // Other close codes (timed out, connection lost mid-handshake) —
          // let the overall timeout decide.
        }
      });
    };

    open().catch((err) => {
      finish({ status: 'failed', detail: err instanceof Error ? err.message : String(err) });
    });
  });
}
