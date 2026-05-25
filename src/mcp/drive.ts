// MCP tools: Google Drive. Search + read content, plus a raw escape hatch.

import { driveClient } from '../google/clients.ts';
import { callMethodPath, rawToolDescription, summarize } from '../google/raw.ts';

function errMsg(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/No stored credentials|No Google accounts/.test(msg)) return `Drive not connected: ${msg}`;
  return `Drive error: ${msg}`;
}

const accountProp = {
  account: {
    type: 'string',
    description: 'Google account alias (from google_accounts). Omit to use the default.',
  },
};

// Google-native mimeType → text export format for drive_read.
const EXPORT_MAP: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.script': 'application/vnd.google-apps.script+json',
};

export const driveSearchTool = {
  definition: {
    name: 'drive_search',
    description:
      'Search the user\'s Google Drive using Drive query syntax. Returns file id, name, mimeType, owners, modifiedTime, and webViewLink for each match. Examples: `name contains \'budget\'`, `mimeType=\'application/vnd.google-apps.spreadsheet\'`, `modifiedTime > \'2026-01-01T00:00:00\'`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        q: { type: 'string', description: 'Drive search query (Drive `q` parameter).' },
        max: { type: 'number', description: 'How many results (default 20, max 100).' },
        ...accountProp,
      },
      required: ['q'],
    },
  },

  async handler(args: Record<string, unknown>) {
    const q = String(args.q ?? '').trim();
    const max = clamp(Number(args.max ?? 20), 1, 100);
    const account = args.account ? String(args.account) : undefined;
    if (!q) {
      return { content: [{ type: 'text', text: 'Error: q is required' }], isError: true };
    }
    try {
      const d = driveClient(account);
      const res = await d.files.list({
        q,
        pageSize: max,
        fields: 'files(id,name,mimeType,modifiedTime,owners(emailAddress),webViewLink)',
        spaces: 'drive',
      });
      const files = res.data.files ?? [];
      if (files.length === 0) return { content: [{ type: 'text', text: '(no matches)' }] };
      const lines = files.map(
        (f) =>
          `${f.id}  ${f.name || '(no name)'}  [${f.mimeType}]\n    ${f.modifiedTime ?? ''}  ${f.webViewLink ?? ''}`,
      );
      return { content: [{ type: 'text', text: lines.join('\n\n') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errMsg(err) }], isError: true };
    }
  },
};

export const driveReadTool = {
  definition: {
    name: 'drive_read',
    description:
      'Read the textual content of a Drive file. Google Docs/Sheets/Slides are exported as text/CSV/text; plain text files are downloaded as-is; binary files return their metadata only (use drive_raw for raw bytes). For full Sheets cells use sheets_read; for full Docs structure use docs_read.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: { type: 'string', description: 'Drive file id.' },
        max_bytes: { type: 'number', description: 'Cap on returned text (default 50000).' },
        ...accountProp,
      },
      required: ['file_id'],
    },
  },

  async handler(args: Record<string, unknown>) {
    const fileId = String(args.file_id ?? '').trim();
    const maxBytes = clamp(Number(args.max_bytes ?? 50000), 1000, 500000);
    const account = args.account ? String(args.account) : undefined;
    if (!fileId) {
      return { content: [{ type: 'text', text: 'Error: file_id is required' }], isError: true };
    }
    try {
      const d = driveClient(account);
      const meta = await d.files.get({ fileId, fields: 'id,name,mimeType,size' });
      const mime = meta.data.mimeType ?? '';
      const name = meta.data.name ?? fileId;
      let text: string;
      if (mime in EXPORT_MAP) {
        const exp = await d.files.export({ fileId, mimeType: EXPORT_MAP[mime]! });
        text = typeof exp.data === 'string' ? exp.data : String(exp.data);
      } else if (mime.startsWith('text/') || mime === 'application/json') {
        const dl = await d.files.get({ fileId, alt: 'media' });
        text = typeof dl.data === 'string' ? dl.data : JSON.stringify(dl.data);
      } else {
        return {
          content: [
            {
              type: 'text',
              text: `Binary file (${mime}, ${meta.data.size ?? '?'} bytes). Use drive_raw with files.get + alt:'media' if you really need the bytes.`,
            },
          ],
        };
      }
      const truncated = text.length > maxBytes ? `${text.slice(0, maxBytes)}\n... (truncated, total ${text.length})` : text;
      return { content: [{ type: 'text', text: `# ${name}\n${mime}\n\n${truncated}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errMsg(err) }], isError: true };
    }
  },
};

export const driveRawTool = {
  definition: {
    name: 'drive_raw',
    description: rawToolDescription(
      'Drive',
      '`files.create` to make a new file/folder, `files.update` to rename or move, `files.copy` to duplicate, `permissions.create` to share',
    ),
    inputSchema: {
      type: 'object' as const,
      properties: {
        method: { type: 'string', description: 'Dotted method path, e.g. "files.create".' },
        params: { type: 'object', description: 'Params object passed to the googleapis call.' },
        ...accountProp,
      },
      required: ['method', 'params'],
    },
  },

  async handler(args: Record<string, unknown>) {
    const method = String(args.method ?? '').trim();
    const params = (args.params ?? {}) as Record<string, unknown>;
    const account = args.account ? String(args.account) : undefined;
    if (!method) return { content: [{ type: 'text', text: 'Error: method is required' }], isError: true };
    try {
      const data = await callMethodPath(driveClient(account), method, params);
      return { content: [{ type: 'text', text: summarize(data) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errMsg(err) }], isError: true };
    }
  },
};

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
