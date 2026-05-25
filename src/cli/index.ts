#!/usr/bin/env bun
// nothingClaw CLI — subcommand router.

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
  console.log(`nothingclaw — personal chat agent

Usage:
  nothingclaw [command]

Commands:
  setup                       Interactive setup (provider, login, channels)
  start                       Start the bot (default)
  status                      Show provider, db stats, recent activity
  provider [gemini|claude]    Switch agent provider (interactive if no arg)
  whatsapp <sub>              WhatsApp ops (reset | status | clear-media)
  voice <sub>                 Voice (Whisper) ops (install | start | stop | status)
  google <sub>                Google OAuth (login | status | logout | test)
  help                        Print this message
`);
}
