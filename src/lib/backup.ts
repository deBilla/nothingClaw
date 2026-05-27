// Daily backup of the operational state.
//
// Targets (whichever exist):
//   data/marsclaw.db    →  data/backups/marsclaw-YYYY-MM-DD.db
//   MEMORY.md              →  data/backups/MEMORY-YYYY-MM-DD.md
//   data/whatsapp-auth/    →  data/backups/whatsapp-auth-YYYY-MM-DD.tar.gz
//
// Rotation: keep the last `KEEP_DAYS` backups; older files are removed.
//
// Strategy for the SQLite copy: use the `VACUUM INTO` command so we get a
// consistent snapshot without locking out writers for long.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { DB_PATH } from '../db/connection.ts';
import { log } from './log.ts';

const BACKUP_DIR = process.env.MARSCLAW_BACKUP_DIR ?? 'data/backups';
const KEEP_DAYS = Number(process.env.MARSCLAW_BACKUP_KEEP ?? 7);
const WA_AUTH_DIR = process.env.MARSCLAW_WHATSAPP_AUTH ?? 'data/whatsapp-auth';
const MEMORY_PATH = 'MEMORY.md';

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function backupDb(date: string): string | null {
  if (!existsSync(DB_PATH)) return null;
  mkdirSync(BACKUP_DIR, { recursive: true });
  const out = join(BACKUP_DIR, `marsclaw-${date}.db`);
  // VACUUM INTO is the right SQLite primitive for backups: atomic, no
  // long write lock, produces a clean defragmented copy.
  const src = new Database(DB_PATH, { readonly: true });
  try {
    src.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  return out;
}

function backupMemory(date: string): string | null {
  if (!existsSync(MEMORY_PATH)) return null;
  mkdirSync(BACKUP_DIR, { recursive: true });
  const out = join(BACKUP_DIR, `MEMORY-${date}.md`);
  copyFileSync(MEMORY_PATH, out);
  return out;
}

function backupWhatsappAuth(date: string): string | null {
  if (!existsSync(WA_AUTH_DIR)) return null;
  mkdirSync(BACKUP_DIR, { recursive: true });
  const out = join(BACKUP_DIR, `whatsapp-auth-${date}.tar.gz`);
  const r = spawnSync('tar', ['-czf', out, '-C', WA_AUTH_DIR, '.'], { encoding: 'utf-8' });
  if (r.status !== 0) {
    log.warn('whatsapp-auth tar failed', { stderr: r.stderr.trim() });
    return null;
  }
  return out;
}

function rotate(): void {
  if (!existsSync(BACKUP_DIR)) return;
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const f of readdirSync(BACKUP_DIR)) {
    const path = join(BACKUP_DIR, f);
    try {
      const st = statSync(path);
      if (st.mtimeMs < cutoff) {
        unlinkSync(path);
        log.debug('backup pruned', { file: f });
      }
    } catch (err) {
      log.debug('backup stat/unlink failed', { file: f, err });
    }
  }
}

export interface BackupResult {
  db: string | null;
  memory: string | null;
  whatsappAuth: string | null;
}

export function runBackup(): BackupResult {
  const date = today();
  log.info('backup start', { date });
  const result: BackupResult = {
    db: backupDb(date),
    memory: backupMemory(date),
    whatsappAuth: backupWhatsappAuth(date),
  };
  rotate();
  log.info('backup complete', { ...result });
  return result;
}

// Schedule daily-ish backups. Fires once on boot if we've never backed up
// for today (cheap idempotency check via file existence), and then every
// 24h. With launchd KeepAlive=true a restart at 4am still hits the same
// guard, so we don't over-backup.
let scheduleTimer: ReturnType<typeof setInterval> | null = null;

export function startBackupSchedule(): void {
  const dailyMs = 24 * 60 * 60 * 1000;
  const todayFile = join(BACKUP_DIR, `marsclaw-${today()}.db`);
  if (!existsSync(todayFile)) {
    // Run now if no backup exists for today.
    try {
      runBackup();
    } catch (err) {
      log.warn('initial backup failed', { err });
    }
  }
  if (scheduleTimer === null) {
    scheduleTimer = setInterval(() => {
      try {
        runBackup();
      } catch (err) {
        log.warn('scheduled backup failed', { err });
      }
    }, dailyMs);
    scheduleTimer.unref?.();
  }
}

export function stopBackupSchedule(): void {
  if (scheduleTimer) {
    clearInterval(scheduleTimer);
    scheduleTimer = null;
  }
}
