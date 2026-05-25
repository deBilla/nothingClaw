// MCP tools: read-only Gmail access. Auth comes from macOS Keychain via
// src/google/auth.ts — set up once with `bun run google login [alias]`.
// Every tool accepts an optional `account` (alias from `nothingclaw google list`).

import { listRecent, search, getMessage, type MessageMeta } from '../google/gmail.ts';

function metaLine(m: MessageMeta): string {
  const date = m.date ? ` [${m.date}]` : '';
  return `${m.id}  ${m.subject || '(no subject)'} — ${m.from}${date}\n    ${m.snippet}`;
}

function errMsg(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/No stored credentials|No Google accounts/.test(msg)) {
    return `Gmail not connected: ${msg}`;
  }
  return `Gmail error: ${msg}`;
}

const accountProp = {
  account: {
    type: 'string',
    description: 'Google account alias (from google_accounts). Omit to use the default account.',
  },
};

export const gmailRecentTool = {
  definition: {
    name: 'gmail_recent',
    description:
      'List the most recent messages in the user\'s Gmail inbox. Returns id, subject, sender, date, and snippet. Use for "what\'s in my inbox"; prefer gmail_search if criteria are given.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        max: { type: 'number', description: 'How many messages (default 10, max 50).' },
        ...accountProp,
      },
    },
  },

  async handler(args: Record<string, unknown>) {
    const max = clamp(Number(args.max ?? 10), 1, 50);
    const account = args.account ? String(args.account) : undefined;
    try {
      const msgs = await listRecent(max, account);
      const body = msgs.length === 0 ? '(no messages)' : msgs.map(metaLine).join('\n\n');
      return { content: [{ type: 'text', text: body }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errMsg(err) }], isError: true };
    }
  },
};

export const gmailSearchTool = {
  definition: {
    name: 'gmail_search',
    description:
      'Search Gmail using Gmail query syntax. Examples: `from:alice@example.com`, `subject:invoice`, `is:unread newer_than:7d`, `has:attachment label:work`. Returns id, subject, sender, date, snippet.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Gmail search query (same syntax as the Gmail UI search box).' },
        max: { type: 'number', description: 'How many messages (default 10, max 50).' },
        ...accountProp,
      },
      required: ['query'],
    },
  },

  async handler(args: Record<string, unknown>) {
    const query = String(args.query ?? '').trim();
    const max = clamp(Number(args.max ?? 10), 1, 50);
    const account = args.account ? String(args.account) : undefined;
    if (!query) {
      return { content: [{ type: 'text', text: 'Error: query is required' }], isError: true };
    }
    try {
      const msgs = await search(query, max, account);
      const body = msgs.length === 0 ? '(no matches)' : msgs.map(metaLine).join('\n\n');
      return { content: [{ type: 'text', text: body }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errMsg(err) }], isError: true };
    }
  },
};

export const gmailGetTool = {
  definition: {
    name: 'gmail_get',
    description:
      'Fetch the full body of a single Gmail message by id. Use the id returned by gmail_recent / gmail_search. Body is plain text (HTML stripped). Extract what you need rather than echoing the whole thing back.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Gmail message id.' },
        ...accountProp,
      },
      required: ['id'],
    },
  },

  async handler(args: Record<string, unknown>) {
    const id = String(args.id ?? '').trim();
    const account = args.account ? String(args.account) : undefined;
    if (!id) {
      return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };
    }
    try {
      const msg = await getMessage(id, account);
      const text = `From: ${msg.from}\nTo: ${msg.to}\nDate: ${msg.date}\nSubject: ${msg.subject}\n\n${
        msg.body || '(empty body)'
      }`;
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errMsg(err) }], isError: true };
    }
  },
};

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
