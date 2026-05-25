// MCP tools: Google Docs. Plain-text read + raw escape hatch for edits.
// Doc edits go through documents.batchUpdate which is request-object heavy,
// so we expose the raw tool and let the agent compose the body.

import { docsClient } from '../google/clients.ts';
import { callMethodPath, rawToolDescription, summarize } from '../google/raw.ts';

function errMsg(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/No stored credentials|No Google accounts/.test(msg)) return `Docs not connected: ${msg}`;
  return `Docs error: ${msg}`;
}

const accountProp = {
  account: {
    type: 'string',
    description: 'Google account alias (from google_accounts). Omit to use the default.',
  },
};

interface DocsElement {
  paragraph?: {
    elements?: Array<{ textRun?: { content?: string | null } | null }> | null;
  } | null;
  table?: {
    tableRows?: Array<{
      tableCells?: Array<{ content?: DocsElement[] | null }> | null;
    }> | null;
  } | null;
  tableOfContents?: { content?: DocsElement[] | null } | null;
}

function extractText(content: DocsElement[] | null | undefined): string {
  if (!content) return '';
  const out: string[] = [];
  for (const el of content) {
    if (el.paragraph) {
      for (const e of el.paragraph.elements ?? []) {
        if (e.textRun?.content) out.push(e.textRun.content);
      }
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) {
          out.push(extractText(cell.content));
        }
        out.push('\n');
      }
    } else if (el.tableOfContents) {
      out.push(extractText(el.tableOfContents.content));
    }
  }
  return out.join('');
}

export const docsReadTool = {
  definition: {
    name: 'docs_read',
    description:
      'Read a Google Doc as plain text (paragraphs and table cells joined; formatting dropped). Returns the document title and body. For structure-aware edits use docs_raw with documents.batchUpdate.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'Google Doc id (from URL or drive_search).' },
        max_bytes: { type: 'number', description: 'Cap on returned text (default 50000).' },
        ...accountProp,
      },
      required: ['document_id'],
    },
  },

  async handler(args: Record<string, unknown>) {
    const id = String(args.document_id ?? '').trim();
    const maxBytes = clamp(Number(args.max_bytes ?? 50000), 1000, 500000);
    const account = args.account ? String(args.account) : undefined;
    if (!id) {
      return { content: [{ type: 'text', text: 'Error: document_id is required' }], isError: true };
    }
    try {
      const c = docsClient(account);
      const res = await c.documents.get({ documentId: id });
      const title = res.data.title ?? id;
      const text = extractText(res.data.body?.content as DocsElement[] | null | undefined);
      const truncated =
        text.length > maxBytes ? `${text.slice(0, maxBytes)}\n... (truncated, total ${text.length})` : text;
      return { content: [{ type: 'text', text: `# ${title}\n\n${truncated}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errMsg(err) }], isError: true };
    }
  },
};

export const docsRawTool = {
  definition: {
    name: 'docs_raw',
    description: rawToolDescription(
      'Docs',
      '`documents.create` to make a new doc, `documents.batchUpdate` to apply a list of edits (insertText, deleteContentRange, replaceAllText, updateTextStyle, etc.) — pass `{ documentId, requestBody: { requests: [...] } }`',
    ),
    inputSchema: {
      type: 'object' as const,
      properties: {
        method: { type: 'string', description: 'Dotted method path, e.g. "documents.batchUpdate".' },
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
      const data = await callMethodPath(docsClient(account), method, params);
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
