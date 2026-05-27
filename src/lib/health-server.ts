// Local HTTP health endpoint.
//
// Binds to 127.0.0.1 only — DON'T expose this to the network. It's for
// uptime monitors, debug curl, or a phone-widget that hits localhost via
// a tunnel.
//
// GET /health  →  200 OK JSON
//   {
//     ok: true,
//     uptime_s: 12345,
//     pid: 45057,
//     heartbeat_age_ms: 532,
//     channels: ["whatsapp"],
//     outbox: { pending: 0, failed: 0 },
//     db: { path: "data/marsclaw.db", size_kb: 80, messages: 144, threads: 5 },
//     today_spend_usd: 0.0123,
//     daily_budget_usd: 5,
//   }
//
// Exit code is 0 even if something looks off; the `ok` field is the signal
// and the rest is body for the monitor to alert on. We never throw from
// the request handler — it's a low-priority observability surface.

import { createServer, type Server } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { DB_PATH } from '../db/connection.ts';
import { log } from './log.ts';
import { loadConfig } from './config.ts';
import { todaySpendUsd } from './cost-tracker.ts';

const HEARTBEAT_PATH = process.env.MARSCLAW_HEARTBEAT ?? 'data/heartbeat';
const WHATSAPP_REAUTH_MARKER = process.env.MARSCLAW_WHATSAPP_REAUTH_MARKER ?? 'data/whatsapp-needs-reauth';

export interface HealthOpts {
  db: Database;
  channels: string[];
  port?: number;
}

function heartbeatAgeMs(): number | null {
  try {
    return Math.max(0, Date.now() - statSync(HEARTBEAT_PATH).mtimeMs);
  } catch {
    return null;
  }
}

function dbStats(db: Database): { path: string; size_kb: number; messages: number; threads: number } {
  let size = 0;
  try {
    size = statSync(DB_PATH).size;
  } catch {
    /* missing */
  }
  let messages = 0;
  let threads = 0;
  try {
    messages = (db.query('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    threads = (db.query('SELECT COUNT(DISTINCT thread_id) AS n FROM messages').get() as { n: number }).n;
  } catch {
    /* not migrated yet */
  }
  return { path: DB_PATH, size_kb: Math.round(size / 1024), messages, threads };
}

function outboxStats(db: Database): { pending: number; failed: number } {
  try {
    const pending = (
      db
        .query('SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NULL AND failed_at IS NULL')
        .get() as { n: number }
    ).n;
    const failed = (db.query('SELECT COUNT(*) AS n FROM outbox WHERE failed_at IS NOT NULL').get() as { n: number }).n;
    return { pending, failed };
  } catch {
    return { pending: 0, failed: 0 };
  }
}

const STARTED_AT = Date.now();

export function startHealthServer(opts: HealthOpts): Server | null {
  const portEnv = process.env.MARSCLAW_HEALTH_PORT;
  const port = opts.port ?? (portEnv ? Number.parseInt(portEnv, 10) : 0);
  if (port === 0) {
    log.info('health endpoint disabled (set MARSCLAW_HEALTH_PORT to enable)');
    return null;
  }

  const server = createServer((req, res) => {
    if (req.url !== '/health' && req.url !== '/') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    try {
      const cfg = loadConfig();
      const hbAge = heartbeatAgeMs();
      const reauthNeeded = existsSync(WHATSAPP_REAUTH_MARKER);
      const body = {
        ok: hbAge !== null && hbAge < 5 * 60_000 && !reauthNeeded,
        uptime_s: Math.round((Date.now() - STARTED_AT) / 1000),
        pid: process.pid,
        heartbeat_age_ms: hbAge,
        channels: opts.channels,
        whatsapp_reauth_needed: reauthNeeded,
        outbox: outboxStats(opts.db),
        db: dbStats(opts.db),
        today_spend_usd: Number(todaySpendUsd().toFixed(4)),
        daily_budget_usd: cfg.daily_usd_budget,
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
    } catch (err) {
      log.warn('health endpoint error', { err });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'health-error' }));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    log.info('health endpoint listening', { url: `http://127.0.0.1:${port}/health` });
  });
  server.on('error', (err) => {
    log.warn('health endpoint failed to start', { err });
  });
  void existsSync; // keep import alive for the migration tests' tree-shaker
  return server;
}

export function stopHealthServer(server: Server | null): void {
  if (!server) return;
  server.close();
}
