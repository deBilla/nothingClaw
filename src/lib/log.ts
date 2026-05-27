// Structured logger with ANSI colour, level threshold, and global unhandled
// handlers. Zero-dep — same shape as nanoclaw-v2's logger, adapted for Bun.
//
// LOG_LEVEL env var: debug | info | warn | error | fatal (default 'info').
// `err` key is special-cased to include constructor name + stack.
//
// File logging: when MARSCLAW_LOG_FILE is set, lines are also tee'd to
// that file. The file is rotated in-process by lib/log-rotate.ts so launchd
// doesn't need to know about it.
//
// Ring buffer: the last RING_SIZE lines are kept in memory and flushed to
// `crashes/<ts>.txt` on uncaughtException — gives you the run-up context
// even when no log file is configured.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFileLogging, writeToFile } from './log-rotate.ts';

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';
// eslint-disable-next-line no-control-regex -- ANSI escape codes by definition include \x1b
const ANSI_RE = /\x1b\[[0-9;]*m/g;

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;
const LOG_FILE = process.env.MARSCLAW_LOG_FILE;
const CRASH_DIR = process.env.MARSCLAW_CRASH_DIR ?? 'crashes';
const RING_SIZE = Number(process.env.MARSCLAW_LOG_RING_SIZE ?? 200);

if (LOG_FILE) {
  startFileLogging(LOG_FILE);
}

// In-memory ring of the last RING_SIZE plain-text log lines. Used for the
// crash dump.
const ring: string[] = [];
function pushRing(line: string): void {
  ring.push(line);
  if (ring.length > RING_SIZE) ring.shift();
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{ type: "${err.constructor.name}", message: "${err.message}", stack: ${err.stack} }`;
  }
  return JSON.stringify(err);
}

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    parts.push(`${KEY_COLOR}${k}${RESET}=${k === 'err' ? formatErr(v) : JSON.stringify(v)}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function strip(s: string): string {
  return s.replace(ANSI_RE, '');
}

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const ansiLine = `[${ts()}] ${tag} ${MSG_COLOR}${msg}${RESET}${data ? formatData(data) : ''}\n`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(ansiLine);
  const plainLine = strip(ansiLine);
  pushRing(plainLine);
  writeToFile(plainLine);
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
  fatal: (msg: string, data?: Record<string, unknown>) => emit('fatal', msg, data),
};

function dumpCrash(reason: string, err: unknown): string | null {
  try {
    mkdirSync(CRASH_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(CRASH_DIR, `crash-${stamp}.txt`);
    const header = `# marsclaw crash dump\n# reason: ${reason}\n# at: ${new Date().toISOString()}\n# pid: ${process.pid}\n\n## Error\n\n${formatErr(err)}\n\n## Last ${ring.length} log lines\n\n`;
    writeFileSync(path, header + ring.join(''));
    return path;
  } catch (writeErr) {
    void writeErr;
    return null;
  }
}

// Without these, an unhandled rejection in an MCP tool or a thrown error in a
// callback is silently swallowed by the runtime — the process keeps going but
// the conversation hangs. Better to log, dump context, and exit cleanly so
// launchd respawns under the circuit breaker.
process.on('uncaughtException', (err) => {
  log.fatal('Uncaught exception', { err });
  const path = dumpCrash('uncaughtException', err);
  if (path) log.fatal('crash dump written', { path });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { err: reason });
  // Don't crash-dump on unhandled rejection — it's recoverable and we don't
  // want every transient promise rejection to fill `crashes/` with noise.
});
