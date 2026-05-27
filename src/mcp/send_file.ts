// MCP tool: queue a file attachment for delivery to the user via the
// outbox. Channels decide how to render it (image inline, doc attachment).
//
// Path safety: the file must exist AND must resolve inside one of
// `config.allowed_paths`. Without this, the agent could ship arbitrary
// host files to the user — circumventing the canUseTool layer that
// gates the Read tool.

import { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { DB_PATH } from '../db/connection.ts';
import { loadConfig } from '../lib/config.ts';

const THREAD_ID = process.env.MARSCLAW_THREAD_ID ?? '';
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB — WhatsApp's document limit is ~100MB

let _db: Database | null = null;
function db(): Database {
  if (!_db) _db = new Database(DB_PATH);
  return _db;
}

function isUnder(target: string, roots: string[]): boolean {
  const t = resolve(target);
  return roots.some((r) => {
    const root = resolve(r);
    return t === root || t.startsWith(root + '/');
  });
}

export const sendFileTool = {
  definition: {
    name: 'send_file',
    description:
      'Send a file (image, PDF, document) to the user. The file must already exist on disk inside the agent\'s allowed paths. Pass `path` (absolute or relative to cwd) and an optional `caption` (text shown alongside the file) and `filename` (display name override). Examples: charts you generated, PDFs, screenshots, exported reports. Use this rather than dumping binary contents into chat.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to project root)' },
        caption: { type: 'string', description: 'Optional text shown with the file' },
        filename: { type: 'string', description: 'Optional display name override' },
      },
      required: ['path'],
    },
  },

  async handler(args: Record<string, unknown>) {
    const rawPath = String(args.path ?? '').trim();
    const caption = String(args.caption ?? '').trim();
    const filename = String(args.filename ?? '').trim();

    if (!rawPath) {
      return { content: [{ type: 'text', text: 'Error: path is required' }], isError: true };
    }
    if (!THREAD_ID) {
      return { content: [{ type: 'text', text: 'Error: MARSCLAW_THREAD_ID not set' }], isError: true };
    }

    const absPath = resolve(rawPath);
    const config = loadConfig();
    if (!isUnder(absPath, config.allowed_paths)) {
      return {
        content: [
          {
            type: 'text',
            text:
              `Error: ${absPath} is outside allowed_paths. ` +
              `Add the parent directory to data/config.json allowed_paths to grant access.`,
          },
        ],
        isError: true,
      };
    }

    if (!existsSync(absPath)) {
      return {
        content: [{ type: 'text', text: `Error: file not found at ${absPath}` }],
        isError: true,
      };
    }

    const st = statSync(absPath);
    if (!st.isFile()) {
      return { content: [{ type: 'text', text: `Error: ${absPath} is not a regular file` }], isError: true };
    }
    if (st.size === 0) {
      return { content: [{ type: 'text', text: `Error: ${absPath} is empty` }], isError: true };
    }
    if (st.size > MAX_BYTES) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${absPath} is ${(st.size / 1024 / 1024).toFixed(1)}MB; max ${MAX_BYTES / 1024 / 1024}MB.`,
          },
        ],
        isError: true,
      };
    }

    const displayName = filename || basename(absPath);
    db()
      .query('INSERT INTO outbox (thread_id, text, file_path, file_name) VALUES (?, ?, ?, ?)')
      .run(THREAD_ID, caption, absPath, displayName);

    return {
      content: [
        { type: 'text', text: `Queued file "${displayName}" (${(st.size / 1024).toFixed(1)}KB).` },
      ],
    };
  },
};
