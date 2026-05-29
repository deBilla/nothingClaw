// Security audit log — append-only JSON-lines record of every tool attempt
// the agent makes: built-in tools (via canUseTool) and MCP tools (when they
// refuse via the mutation gate). The point isn't observability for ops (the
// regular `pino` log handles that) — it's a forensic trail so that if an
// injection succeeds, you can answer "what did the agent try to do, and what
// did the gate block?" after the fact.
//
// Design choices:
//   • Separate file from app logs (logs/audit.log) so volume / retention can
//     be reasoned about independently.
//   • JSON Lines, append-only — every line is a self-contained record.
//   • Writes use O_APPEND so concurrent appends from the main process and the
//     MCP child don't tear small lines (POSIX guarantees atomicity below
//     PIPE_BUF, which JSON Lines easily fit under).
//   • No rotation in-process — operators can `logrotate` it externally; we
//     don't want to lose security history to a rotation race.
//
// What this does NOT give you: tamper-resistance against an attacker with
// host-level access. The file is on the same disk as everything else and the
// agent's host user can rewrite it. Real tamper-evidence needs an external
// log sink (syslog, a remote service) — which is a fair next step if you
// outgrow this. For a personal bot, an honest local trail is the right size.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type AuditDecision = 'allow' | 'deny' | 'blocked';

export interface AuditRecord {
  /** Tool name as the SDK sees it (e.g. "Bash", "WebFetch", "mcp__marsclaw__gmail_send"). */
  tool: string;
  decision: AuditDecision;
  /** Short reason for deny/blocked; omitted for allow. */
  reason?: string;
  /** Short, redacted hint at what the tool was asked to do (URL, command preview, file_path). */
  subject?: string;
  /** Layer that made the decision: built-in permission gate, mutation gate, etc. */
  layer?:
    | 'canUseTool'
    | 'mutation-gate'
    | 'sensitive-paths'
    | 'url-allowlist'
    | 'shell-disabled'
    | 'web-disabled'
    | 'egress-gateway';
}

// Path is resolved lazily so the env var can be set before each call. Each
// distinct path we've ever written to is dir-ensured once and remembered.
const ensuredDirs = new Set<string>();

function currentPath(): string {
  return process.env.MARSCLAW_AUDIT_LOG ?? 'logs/audit.log';
}

function ensureDirFor(p: string): void {
  const d = dirname(p);
  if (!d || ensuredDirs.has(d)) return;
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  ensuredDirs.add(d);
}

export function audit(rec: AuditRecord): void {
  const p = currentPath();
  try {
    ensureDirFor(p);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        ...rec,
      }) + '\n';
    appendFileSync(p, line, { encoding: 'utf8' });
  } catch (err) {
    // Audit logging must never crash the bot — but a write failure is itself
    // a signal worth surfacing once via the regular logger. Use console to
    // avoid an import cycle with lib/log.ts (which is a heavier module).
    void err;
    process.stderr.write(`[audit] write failed: ${(err as Error)?.message ?? err}\n`);
  }
  if (rec.decision === 'deny' || rec.decision === 'blocked') {
    noteDenial(rec);
  }
}

// --- Density-based denial alerting ----------------------------------------
//
// A real prompt-injection attempt typically triggers a *burst* of denials in
// rapid succession (try to read .env, try to send to attacker.com, try a
// different domain, try shell, …) before the model gives up. The forensic
// audit log catches every one, but the operator only sees it after grepping.
//
// We add a sliding-window counter: when ≥THRESHOLD denials happen within
// WINDOW_MS, fire a single alert via the registered alerter, and suppress
// further alerts for COOLDOWN_MS so a sustained injection doesn't flood the
// channel.
//
// The alerter is registered from `cli/index.ts start` once the channel router
// is up, so the alert lands in the operator's chat thread (or stderr if no
// channel is registered). The audit module deliberately does NOT import the
// channel router — that would create a dep cycle and make audit useless
// during boot. Keep this module purely passive.

interface DenialEvent {
  ts: number;
  rec: AuditRecord;
}

const ALERT_WINDOW_MS = 60_000;
const ALERT_THRESHOLD = 5;
const ALERT_COOLDOWN_MS = 5 * 60_000;

const recentDenials: DenialEvent[] = [];
let lastAlertAt = 0;

type Alerter = (summary: string, sample: AuditRecord[]) => void;
let alerter: Alerter | null = null;

/** Register a runtime alerter for denial-density events (called from cli/index). */
export function registerAuditAlerter(fn: Alerter | null): void {
  alerter = fn;
}

function noteDenial(rec: AuditRecord): void {
  const now = Date.now();
  recentDenials.push({ ts: now, rec });
  // Drop events older than the window.
  const cutoff = now - ALERT_WINDOW_MS;
  while (recentDenials.length > 0 && recentDenials[0]!.ts < cutoff) recentDenials.shift();
  if (recentDenials.length < ALERT_THRESHOLD) return;
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = now;
  const sample = recentDenials.slice(-ALERT_THRESHOLD).map((d) => d.rec);
  const tools = [...new Set(sample.map((r) => r.tool))].join(', ');
  const summary =
    `⚠️ marsClaw: ${recentDenials.length} tool denials in ${Math.round(ALERT_WINDOW_MS / 1000)}s` +
    ` — possible prompt injection. Tools: ${tools}. See logs/audit.log.`;
  try {
    if (alerter) alerter(summary, sample);
    else process.stderr.write(`[audit] ${summary}\n`);
  } catch (err) {
    process.stderr.write(`[audit] alerter threw: ${(err as Error)?.message ?? err}\n`);
  }
}

/** Test-only — clear the in-memory denial counter so tests are deterministic. */
export function _resetAuditAlertStateForTests(): void {
  recentDenials.length = 0;
  lastAlertAt = 0;
}

/** Read-side helper used by tests; trivial enough to inline. */
export function _auditPathForTests(): string {
  return currentPath();
}
