// SQLite connection + migration runner. Single entry point for the rest of
// the app — every other src/db/* module takes a Database as an argument.

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrations } from './migrations.ts';

export const DB_PATH = process.env.MARSCLAW_DB ?? 'data/marsclaw.db';

export function initDb(): Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  runMigrations(db);
  return db;
}
