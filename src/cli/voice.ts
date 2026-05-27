// Manage the local Whisper (STT) + Kokoro (TTS) sidecars.
//
// Usage:
//   marsclaw voice install      Run tools/setup-voice.sh (venv + models)
//   marsclaw voice start        Start both sidecars (detached)
//   marsclaw voice stop         Stop both
//   marsclaw voice restart      Stop + start
//   marsclaw voice status       Show running / healthy for each

import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { kokoroHealthy, whisperHealthy } from '../voice.ts';
import { printBanner } from './branding.ts';

const VENV_DIR = 'tools/voice-env';
const INSTALLER = 'tools/setup-voice.sh';

interface Sidecar {
  name: 'whisper' | 'kokoro';
  script: string;
  pidFile: string;
  logFile: string;
  healthy: () => Promise<boolean>;
}

const SIDECARS: Sidecar[] = [
  {
    name: 'whisper',
    script: 'tools/whisper-server.py',
    pidFile: 'data/voice-whisper.pid',
    logFile: 'data/voice-whisper.log',
    healthy: whisperHealthy,
  },
  {
    name: 'kokoro',
    script: 'tools/kokoro-server.py',
    pidFile: 'data/voice-kokoro.pid',
    logFile: 'data/voice-kokoro.log',
    healthy: kokoroHealthy,
  },
];

const ok   = (s: string) => console.log(`\x1b[32m✓\x1b[0m ${s}`);
const info = (s: string) => console.log(`  ${s}`);
const warn = (s: string) => console.log(`\x1b[33m!\x1b[0m ${s}`);
const fail = (s: string) => console.error(`\x1b[31m✗\x1b[0m ${s}`);

function isPidAlive(pid: number): boolean {
  // `kill -0` is the standard liveness probe — ESRCH means dead, EPERM
  // means alive-but-not-ours. We treat any throw as dead because the only
  // case where the PID file exists but the process isn't ours is a PID reuse,
  // which is rare on macOS and at worst causes a "restart" no-op.
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    void err;
    return false;
  }
}

function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, 'utf-8').trim());
  if (!Number.isFinite(pid)) return null;
  return isPidAlive(pid) ? pid : null;
}

function install(): void {
  if (!existsSync(INSTALLER)) { fail(`${INSTALLER} missing.`); process.exit(1); }
  const r = spawnSync('bash', [INSTALLER], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

function startOne(s: Sidecar): void {
  if (readPid(s.pidFile)) { warn(`${s.name}: already running.`); return; }
  if (!existsSync(VENV_DIR)) { fail('Voice not installed. Run: bun run voice install'); process.exit(1); }
  if (!existsSync(s.script)) { fail(`${s.script} missing.`); process.exit(1); }

  mkdirSync('data', { recursive: true });
  const logFd = openSync(s.logFile, 'a');
  const child = spawn(`${VENV_DIR}/bin/python`, [s.script], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  writeFileSync(s.pidFile, String(child.pid));
  ok(`${s.name}: starting (pid=${child.pid}, log=${s.logFile})`);
}

function stopOne(s: Sidecar): void {
  const pid = readPid(s.pidFile);
  if (!pid) { info(`${s.name}: not running.`); return; }
  try {
    process.kill(pid, 'SIGTERM');
    ok(`${s.name}: stopped (pid=${pid})`);
  } catch (e) {
    fail(`${s.name}: failed to stop (${e instanceof Error ? e.message : e})`);
  }
}

async function statusOne(s: Sidecar): Promise<void> {
  const pid = readPid(s.pidFile);
  if (!pid) { info(`${s.name}: not running`); return; }
  const healthy = await s.healthy();
  info(`${s.name}: running (pid=${pid})  health=${healthy ? '\x1b[32mok\x1b[0m' : '\x1b[33munreachable\x1b[0m'}`);
}

async function main(): Promise<void> {
  printBanner('voice');
  const sub = process.argv[3] ?? 'help';

  switch (sub) {
    case 'install': install(); break;
    case 'start':   SIDECARS.forEach(startOne); info('Models warm up on the first request (~3-5s).'); break;
    case 'stop':    SIDECARS.forEach(stopOne); break;
    case 'restart':
      SIDECARS.forEach(stopOne);
      await new Promise((r) => setTimeout(r, 500));
      SIDECARS.forEach(startOne);
      break;
    case 'status':  for (const s of SIDECARS) await statusOne(s); break;
    case 'help':
    default:
      console.log('Usage: marsclaw voice <command>\n');
      console.log('Commands:');
      console.log('  install    Create Python venv + install faster-whisper + kokoro-onnx + cache models');
      console.log('  start      Start both Whisper (STT) and Kokoro (TTS) sidecars');
      console.log('  stop       Stop both sidecars');
      console.log('  restart    Stop + start');
      console.log('  status     Show whether each is running and healthy');
      console.log('\nAfter install, set MARSCLAW_VOICE=1 in .env to enable voice processing.');
      break;
  }
}

main();
