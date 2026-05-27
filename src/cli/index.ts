#!/usr/bin/env bun
// marsClaw CLI — subcommand router.

export {};

const cmd = process.argv[2] ?? 'start';

switch (cmd) {
  case 'setup':
    await import('./setup.ts');
    break;
  case 'start':
    await import('../index.ts');
    break;
  case 'status':
    await import('./status.ts');
    break;
  case 'provider':
    await import('./provider.ts');
    break;
  case 'whatsapp':
    await import('./whatsapp.ts');
    break;
  case 'voice':
    await import('./voice.ts');
    break;
  case 'google':
    await import('./google.ts');
    break;
  case 'service':
    await import('./service.ts');
    break;
  case 'path':
    await import('./path.ts');
    break;
  case 'backup':
    await import('./backup.ts');
    break;
  case 'db':
    await import('./db.ts');
    break;
  case 'usage':
    await import('./usage.ts');
    break;
  case 'update':
    await import('./update.ts');
    break;
  case 'smoke':
    await import('./smoke.ts');
    break;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${cmd}\n`);
    printHelp();
    process.exit(1);
}

function printHelp(): void {
  console.log(`marsclaw — personal chat agent

Usage:
  marsclaw [command]

Commands:
  setup                       Interactive setup (provider, login, channels)
  start                       Start the bot (default)
  status                      Show provider, db stats, recent activity
  provider [gemini|claude]    Switch agent provider (interactive if no arg)
  whatsapp <sub>              WhatsApp ops (reset | status | clear-media)
  voice <sub>                 Voice (Whisper) ops (install | start | stop | status)
  google <sub>                Google OAuth (login | status | logout | test)
  service <sub>               Manage launchd service (install | uninstall | start | stop | restart | status | logs)
  path <sub>                  Manage agent allowed_paths (list | add <p> | remove <p> | reset)
  backup                      Run a one-shot backup (db + MEMORY.md + whatsapp-auth)
  db <sub>                    DB maintenance (stats | vacuum | integrity)
  usage <sub>                 Anthropic spend (today | week | by-thread)
  update [--force]            Pull latest, install deps, restart service
  smoke [prompt]              Fire a synthetic message through the agent end-to-end
  help                        Print this message
`);
}
