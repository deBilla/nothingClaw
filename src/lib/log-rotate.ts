// In-process log rotation.
//
// When `MARSCLAW_LOG_FILE` is set, the logger appends to that file.
// This module checks file size every 60s and, when it exceeds the cap,
// rotates: `name → name.1`, `.1 → .2`, ..., dropping `.5`. The active
// stream is reopened against the fresh file.
//
// Why in-process and not newsyslog? launchd holds the stdout/stderr fds
// open across rotations — newsyslog renames the file but launchd keeps
// writing to the renamed inode. The clean fix is to own the file from
// inside the process so we can re-open the fd ourselves.

import { createWriteStream, existsSync, renameSync, statSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const MAX_BYTES = Number(process.env.MARSCLAW_LOG_MAX_BYTES ?? 10 * 1024 * 1024);
const ROTATIONS = Number(process.env.MARSCLAW_LOG_ROTATIONS ?? 5);
const CHECK_INTERVAL_MS = 60_000;

let stream: WriteStream | null = null;
let path: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function startFileLogging(filePath: string): WriteStream {
  mkdirSync(dirname(filePath), { recursive: true });
  path = filePath;
  stream = createWriteStream(filePath, { flags: 'a' });
  if (timer === null) {
    timer = setInterval(() => maybeRotate(), CHECK_INTERVAL_MS);
    timer.unref?.();
  }
  return stream;
}

export function writeToFile(line: string): void {
  if (!stream) return;
  stream.write(line);
}

export function stopFileLogging(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (stream) {
    stream.end();
    stream = null;
  }
}

function maybeRotate(): void {
  if (!path || !stream) return;
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size < MAX_BYTES) return;

  // Shift .4 → .5, .3 → .4, …, .1 → .2.
  for (let i = ROTATIONS - 1; i >= 1; i--) {
    const from = `${path}.${i}`;
    const to = `${path}.${i + 1}`;
    if (existsSync(from)) {
      try {
        renameSync(from, to);
      } catch {
        // Best-effort. If a rename fails, the next rotation will retry.
      }
    }
  }
  // Active → .1, then open fresh.
  try {
    stream.end();
    renameSync(path, `${path}.1`);
  } catch {
    // If rename fails (e.g. permission), keep using the existing stream.
    stream = createWriteStream(path, { flags: 'a' });
    return;
  }
  stream = createWriteStream(path, { flags: 'a' });
}
