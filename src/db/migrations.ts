// Forward-only schema migrator. Reads `migrations/NNNN_*.sql` files in
// lexicographic order and applies each in its own transaction, tracking
// applied versions in `schema_migrations`.
//
// Bootstrap: an existing pre-migration database (created before this
// system existed) has the messages / outbox / sessions tables but no
// `schema_migrations` row. Detect that case and stamp 0001 + 0002 as
// already applied without re-running them. 0003 (and any future
// migration) then runs normally.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { log } from '../lib/log.ts';

const MIGRATIONS_DIR = process.env.MARSCLAW_MIGRATIONS_DIR ?? 'migrations';
const BOOTSTRAP_STAMP_AT = 2; // schemas predating this system match 0001 + 0002

function ensureSchemaTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}

function appliedVersions(db: Database): Set<number> {
  const rows = db.query('SELECT version FROM schema_migrations').all() as { version: number }[];
  return new Set(rows.map((r) => r.version));
}

function tableExists(db: Database, name: string): boolean {
  const row = db.query('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('table', name);
  return row !== null;
}

interface MigrationFile {
  version: number;
  name: string;
  path: string;
}

function discoverMigrations(): MigrationFile[] {
  const entries = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const out: MigrationFile[] = [];
  for (const name of entries) {
    const m = name.match(/^(\d+)_/);
    if (!m) {
      log.warn('Skipping migration without numeric prefix', { name });
      continue;
    }
    out.push({ version: Number.parseInt(m[1], 10), name, path: join(MIGRATIONS_DIR, name) });
  }
  return out;
}

export function runMigrations(db: Database): void {
  ensureSchemaTable(db);

  const isFreshDb = !tableExists(db, 'messages');
  const applied = appliedVersions(db);

  // Bootstrap branch: existing pre-migration schema. Stamp 0001 + 0002 as
  // applied without running them so we don't double-create tables.
  if (!isFreshDb && applied.size === 0) {
    const tx = db.transaction(() => {
      for (let v = 1; v <= BOOTSTRAP_STAMP_AT; v++) {
        db.query('INSERT INTO schema_migrations (version) VALUES (?)').run(v);
      }
    });
    tx();
    log.info('Stamped pre-existing schema as up-to-date', { upTo: BOOTSTRAP_STAMP_AT });
    for (let v = 1; v <= BOOTSTRAP_STAMP_AT; v++) applied.add(v);
  }

  const migrations = discoverMigrations();
  for (const mig of migrations) {
    if (applied.has(mig.version)) continue;
    const sql = readFileSync(mig.path, 'utf-8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.query('INSERT INTO schema_migrations (version) VALUES (?)').run(mig.version);
    });
    tx();
    log.info('Applied migration', { version: mig.version, name: mig.name });
  }
}
