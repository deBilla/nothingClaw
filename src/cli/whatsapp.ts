// WhatsApp channel management.
//
// Usage:
//   marsclaw whatsapp reset    Clear linked-device auth (forces re-scan)
//   marsclaw whatsapp status   Show whether currently linked
//   marsclaw whatsapp          Print usage

import { existsSync, rmSync, readdirSync } from 'node:fs';
import { printBanner } from './branding.ts';

const AUTH_DIR = process.env.MARSCLAW_WHATSAPP_AUTH ?? 'data/whatsapp-auth';
const MEDIA_DIR = process.env.MARSCLAW_WHATSAPP_MEDIA ?? 'data/whatsapp-media';

const ok   = (s: string) => console.log(`\x1b[32m✓\x1b[0m ${s}`);
const info = (s: string) => console.log(`  ${s}`);
const warn = (s: string) => console.log(`\x1b[33m!\x1b[0m ${s}`);

const sub = process.argv[3] ?? 'help';

switch (sub) {
  case 'reset':
  case 'logout':
  case 'relink':
    printBanner('whatsapp reset');
    if (existsSync(AUTH_DIR)) {
      rmSync(AUTH_DIR, { recursive: true, force: true });
      ok(`removed ${AUTH_DIR}`);
    } else {
      info(`${AUTH_DIR} did not exist — nothing to clear`);
    }
    console.log();
    warn('Stop the running bot first (Ctrl+C in its terminal), then:');
    info('  bun run start');
    info('A fresh QR will print. On your phone:');
    info('  Settings → Linked devices → Link a device → scan');
    break;

  case 'status': {
    const linked = existsSync(AUTH_DIR);
    const mediaCount = existsSync(MEDIA_DIR) ? readdirSync(MEDIA_DIR).length : 0;
    if (linked) ok(`linked (auth state in ${AUTH_DIR})`);
    else info(`not linked — no auth state at ${AUTH_DIR}`);
    info(`media files cached: ${mediaCount}`);
    break;
  }

  case 'clear-media': {
    if (existsSync(MEDIA_DIR)) {
      const n = readdirSync(MEDIA_DIR).length;
      rmSync(MEDIA_DIR, { recursive: true, force: true });
      ok(`cleared ${n} media file(s) from ${MEDIA_DIR}`);
    } else {
      info('no cached media to clear');
    }
    break;
  }

  case 'help':
  default:
    console.log('Usage: marsclaw whatsapp <command>\n');
    console.log('Commands:');
    console.log('  reset         Clear linked-device auth — next start triggers a new QR');
    console.log('  status        Show link state and cached media count');
    console.log('  clear-media   Delete cached message media (images, etc.)');
    break;
}
