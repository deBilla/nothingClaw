// `bun run db <sub>` — operational DB maintenance.
//
// Subcommands:
//   vacuum     Compact + defragment (rebuilds the file). Read lock briefly.
//   integrity  Run PRAGMA integrity_check; print "ok" or the list of issues.
//   stats      Show row counts and on-disk size.

import { existsSync, statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { DB_PATH } from '../db/connection.ts';

const sub = process.argv[3] ?? 'stats';

if (!existsSync(DB_PATH)) {
  console.error(`No DB at ${DB_PATH} — start the bot once first.`);
  process.exit(1);
}

function vacuum(): void {
  const db = new Database(DB_PATH);
  const beforeKb = (statSync(DB_PATH).size / 1024).toFixed(1);
  console.log(`Before: ${beforeKb} KB. Running VACUUM…`);
  db.exec('VACUUM');
  db.close();
  const afterKb = (statSync(DB_PATH).size / 1024).toFixed(1);
  console.log(`After:  ${afterKb} KB.`);
}

function integrity(): void {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.query('PRAGMA integrity_check').all() as { integrity_check: string }[];
  db.close();
  if (rows.length === 1 && rows[0].integrity_check === 'ok') {
    console.log('✓ integrity ok');
    return;
  }
  console.error('✗ integrity issues:');
  for (const r of rows) console.error('  ' + r.integrity_check);
  process.exit(1);
}

function stats(): void {
  const db = new Database(DB_PATH, { readonly: true });
  const sizeKb = (statSync(DB_PATH).size / 1024).toFixed(1);
  console.log(`path:           ${DB_PATH}`);
  console.log(`size:           ${sizeKb} KB`);
  const tables = ['messages', 'outbox', 'sessions', 'schema_migrations'];
  for (const t of tables) {
    try {
      const row = db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
      console.log(`${t.padEnd(15)} ${row.n}`);
    } catch {
      /* table missing */
    }
  }
  db.close();
}

switch (sub) {
  case 'vacuum':
    vacuum();
    break;
  case 'integrity':
    integrity();
    break;
  case 'stats':
    stats();
    break;
  default:
    console.error(`Unknown db subcommand: ${sub}`);
    console.error('Usage: marsclaw db [vacuum | integrity | stats]');
    process.exit(1);
}
