// Liveness signal: touched on every agent-turn entry/exit and on every SDK
// message. The host can read `data/heartbeat` mtime to decide whether a
// session is making progress or stuck. Also useful for typing-indicator
// gating (future work) and for service-uptime checks.

import { writeAtomic } from './atomic.ts';

const HEARTBEAT_PATH = process.env.MARSCLAW_HEARTBEAT ?? 'data/heartbeat';

export function touchHeartbeat(): void {
  // Write a string (not just timestamp the file) so the contents are also
  // useful — `cat data/heartbeat` shows the last activity instant.
  writeAtomic(HEARTBEAT_PATH, `${Date.now()}\n`);
}
